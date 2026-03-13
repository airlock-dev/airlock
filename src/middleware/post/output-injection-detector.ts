import type { Middleware } from '../types.js';
import { childLogger } from '../../util/logger.js';

const log = childLogger('mw:output-injection');

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /ignore\s+(all\s+)?prior\s+instructions/i,
  /disregard\s+(all\s+)?previous/i,
  /you\s+are\s+now\s+(a|an)\s/i,
  /new\s+instructions?\s*:/i,
  /system\s*:\s/i,
  /<\s*system\s*>/i,
  /\[INST\]/i,
  /\[\/INST\]/i,
  /<<\s*SYS\s*>>/i,
  /\bAssistant:\s/i,
  /\bHuman:\s/i,
  /\bUser:\s/i,
  /do\s+not\s+follow\s+(any\s+)?previous/i,
  /forget\s+(all\s+)?(your\s+)?instructions/i,
  /override\s+(all\s+)?instructions/i,
];

export type InjectionDetectorMode = 'detect' | 'mangle';

export interface OutputInjectionDetectorOptions {
  mode?: InjectionDetectorMode;
}

export function outputInjectionDetectorMiddleware(
  opts: OutputInjectionDetectorOptions = {}
): Middleware {
  const mode = opts.mode ?? 'detect';

  return async (ctx, next) => {
    const response = await next();

    let flagged = false;
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(response.text)) {
        flagged = true;
        if (mode === 'mangle') {
          response.text = response.text.replace(
            new RegExp(pattern.source, pattern.flags + (pattern.flags.includes('g') ? '' : 'g')),
            '[REDACTED: suspected injection]'
          );
        }
      }
    }

    if (flagged) {
      log.warn(
        { agentId: ctx.agentId, tool: ctx.toolName, mode },
        'Injection pattern detected in output'
      );
      ctx.deps.auditLogger.log({
        agent_id: ctx.agentId,
        tool: ctx.toolName,
        args: JSON.stringify(ctx.args),
        result: 'injection_detected',
      });
    }

    return response;
  };
}
