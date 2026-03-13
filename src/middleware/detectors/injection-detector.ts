import type { Middleware } from '../types.js';
import { childLogger } from '../../util/logger.js';

const log = childLogger('mw:injection-detector');

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /ignore\s+(all\s+)?prior\s+instructions/i,
  /disregard\s+(all\s+)?previous/i,
  /you\s+are\s+now\s+(a|an)\s/i,
  /new\s+instructions?\s*:/i,
  /<\s*system\s*>/i,
  /\[INST\]/i,
  /\[\/INST\]/i,
  /<<\s*SYS\s*>>/i,
  /do\s+not\s+follow\s+(any\s+)?previous/i,
  /forget\s+(all\s+)?(your\s+)?instructions/i,
  /override\s+(all\s+)?instructions/i,
  /\bact\s+as\s+(a|an|if)\b/i,
  /\bpretend\s+(you\s+are|to\s+be)\b/i,
  /\brole\s*play\b/i,
  /\bjailbreak\b/i,
  /\bDAN\s+mode\b/i,
];

export type InjectionDetectorMode = 'detect' | 'mangle' | 'escalate';

export interface InjectionDetectorOptions {
  backend?: 'regex' | 'deberta';
  mode?: InjectionDetectorMode;
  /** URL of DeBERTa inference server (e.g. http://localhost:8000/predict) */
  inference_url?: string;
  /** Confidence threshold for DeBERTa (0-1, default 0.8) */
  threshold?: number;
}

async function classifyWithDeberta(
  text: string,
  inferenceUrl: string,
  threshold: number
): Promise<{ isInjection: boolean; score: number }> {
  const response = await fetch(inferenceUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error(`DeBERTa inference failed: ${response.status}`);
  }

  const result = (await response.json()) as {
    score?: number;
    label?: string;
    probability?: number;
  };
  const score = result.score ?? result.probability ?? 0;
  return { isInjection: score >= threshold, score };
}

function classifyWithRegex(text: string): { isInjection: boolean; matchedPatterns: string[] } {
  const matched: string[] = [];
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      matched.push(pattern.source);
    }
  }
  return { isInjection: matched.length > 0, matchedPatterns: matched };
}

function mangleText(text: string): string {
  let result = text;
  for (const pattern of INJECTION_PATTERNS) {
    result = result.replace(new RegExp(pattern, 'gi'), '[REDACTED: suspected injection]');
  }
  return result;
}

export function injectionDetectorMiddleware(opts: InjectionDetectorOptions = {}): Middleware {
  const { backend = 'regex', mode = 'detect', inference_url, threshold = 0.8 } = opts;

  return async (ctx, next) => {
    // Pre-execution: scan args
    const argsText = JSON.stringify(ctx.args);
    let preInjection: boolean;

    if (backend === 'deberta' && inference_url) {
      try {
        const result = await classifyWithDeberta(argsText, inference_url, threshold);
        preInjection = result.isInjection;
        if (preInjection) {
          log.warn(
            { agentId: ctx.agentId, tool: ctx.toolName, score: result.score },
            'DeBERTa: injection detected in args'
          );
        }
      } catch (err) {
        log.warn({ err }, 'DeBERTa inference failed for args, falling back to regex');
        preInjection = classifyWithRegex(argsText).isInjection;
        if (mode === 'escalate') {
          ctx.meta.needsApproval = true;
          ctx.meta.approvalReason = 'DeBERTa inference unavailable — escalating as precaution';
        }
      }
    } else {
      const result = classifyWithRegex(argsText);
      preInjection = result.isInjection;
      if (preInjection) {
        log.warn(
          { agentId: ctx.agentId, tool: ctx.toolName, patterns: result.matchedPatterns },
          'Regex: injection detected in args'
        );
      }
    }

    if (preInjection) {
      ctx.deps.auditLogger.log({
        agent_id: ctx.agentId,
        tool: ctx.toolName,
        args: JSON.stringify(ctx.args),
        result: 'injection_detected_args',
      });

      if (mode === 'escalate') {
        ctx.meta.needsApproval = true;
        ctx.meta.approvalReason = 'Prompt injection detected in tool arguments';
      }
    }

    const response = await next();

    // Post-execution: scan response
    let postInjection: boolean;

    if (backend === 'deberta' && inference_url) {
      try {
        const result = await classifyWithDeberta(response.text, inference_url, threshold);
        postInjection = result.isInjection;
      } catch (err) {
        log.warn({ err }, 'DeBERTa inference failed for response, falling back to regex');
        postInjection = classifyWithRegex(response.text).isInjection;
        if (mode === 'escalate') {
          ctx.meta.needsApproval = true;
          ctx.meta.approvalReason = 'DeBERTa inference unavailable — escalating as precaution';
        }
      }
    } else {
      postInjection = classifyWithRegex(response.text).isInjection;
    }

    if (postInjection) {
      log.warn(
        { agentId: ctx.agentId, tool: ctx.toolName },
        'Injection pattern detected in response'
      );
      ctx.deps.auditLogger.log({
        agent_id: ctx.agentId,
        tool: ctx.toolName,
        args: JSON.stringify(ctx.args),
        result: 'injection_detected_response',
      });

      if (mode === 'mangle') {
        response.text = mangleText(response.text);
      }
    }

    return response;
  };
}
