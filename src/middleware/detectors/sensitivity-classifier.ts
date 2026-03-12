import type { Middleware } from '../types.js';
import { childLogger } from '../../util/logger.js';

const log = childLogger('mw:sensitivity-classifier');

export type SensitivityMode = 'detect' | 'escalate';
export type SensitivityBackend = 'heuristic' | 'llm';

export interface SensitivityClassifierOptions {
  mode?: SensitivityMode;
  threshold?: number;
  backend?: SensitivityBackend;
  /** Model ID for LLM backend (Vercel AI SDK model reference) */
  model?: string;
}

// PII and sensitive data patterns
const SENSITIVITY_PATTERNS: Array<{ pattern: RegExp; weight: number; label: string }> = [
  // SSN
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/, weight: 0.9, label: 'SSN' },
  // Credit card (Luhn-like)
  { pattern: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/, weight: 0.9, label: 'credit_card' },
  // Email
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/, weight: 0.3, label: 'email' },
  // Phone
  { pattern: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/, weight: 0.3, label: 'phone' },
  // API keys / tokens (generic long hex/base64 strings)
  { pattern: /\b(?:sk|pk|api|token|key|secret|bearer)[-_]?[A-Za-z0-9_-]{20,}\b/i, weight: 0.7, label: 'api_key' },
  // AWS keys
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, weight: 0.95, label: 'aws_access_key' },
  // Private keys
  { pattern: /-----BEGIN\s(?:RSA\s)?PRIVATE\sKEY-----/, weight: 0.95, label: 'private_key' },
  // JWT
  { pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/, weight: 0.6, label: 'jwt' },
  // Internal IPs
  { pattern: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/, weight: 0.4, label: 'internal_ip' },
  // Password-like fields
  { pattern: /["']?password["']?\s*[:=]\s*["'][^"']+["']/i, weight: 0.8, label: 'password' },
];

function heuristicScore(text: string): { score: number; labels: string[] } {
  let maxWeight = 0;
  const labels: string[] = [];
  for (const { pattern, weight, label } of SENSITIVITY_PATTERNS) {
    if (pattern.test(text)) {
      labels.push(label);
      maxWeight = Math.max(maxWeight, weight);
    }
  }
  return { score: maxWeight, labels };
}

async function llmScore(
  text: string,
  model: string,
): Promise<{ score: number; reasoning: string }> {
  const { generateText } = await import('ai');

  const { text: result } = await generateText({
    model: model as any,
    system: 'You are a data sensitivity classifier. Rate the sensitivity of the following data on a scale from 0.0 to 1.0, where 0 is public information and 1.0 is highly sensitive (PII, credentials, medical records, financial data). Respond with ONLY a JSON object: {"score": <number>, "reasoning": "<brief explanation>"}',
    prompt: text.slice(0, 20_000),
    maxOutputTokens: 256,
  });

  try {
    return JSON.parse(result);
  } catch {
    log.warn('Failed to parse LLM sensitivity response, falling back to high score');
    return { score: 1.0, reasoning: 'Failed to parse LLM response — defaulting to high sensitivity' };
  }
}

export function sensitivityClassifierMiddleware(opts: SensitivityClassifierOptions = {}): Middleware {
  const { mode = 'detect', threshold = 0.7, backend = 'heuristic', model } = opts;

  return async (ctx, next) => {
    // Pre-execution: scan args
    const argsText = JSON.stringify(ctx.args);
    await checkSensitivity(argsText, 'args', ctx, backend, model, threshold, mode);

    const response = await next();

    // Post-execution: scan response
    await checkSensitivity(response.text, 'response', ctx, backend, model, threshold, mode);

    return response;
  };
}

async function checkSensitivity(
  text: string,
  phase: 'args' | 'response',
  ctx: import('../types.js').ToolCallContext,
  backend: SensitivityBackend,
  model: string | undefined,
  threshold: number,
  mode: SensitivityMode,
): Promise<void> {
  let score: number;
  let details: string;

  if (backend === 'llm' && model) {
    try {
      const result = await llmScore(text, model);
      score = result.score;
      details = result.reasoning;
    } catch (err) {
      log.warn({ err }, 'LLM sensitivity classification failed, falling back to heuristic');
      const h = heuristicScore(text);
      score = h.score;
      details = h.labels.join(', ');
    }
  } else {
    const h = heuristicScore(text);
    score = h.score;
    details = h.labels.join(', ');
  }

  if (score >= threshold) {
    log.warn(
      { agentId: ctx.agentId, tool: ctx.toolName, score, phase, details },
      'High sensitivity data detected',
    );
    ctx.deps.auditLogger.log({
      agent_id: ctx.agentId, tool: ctx.toolName,
      args: JSON.stringify(ctx.args),
      result: `sensitivity_${phase}`,
      error: `score=${score}, labels=${details}`,
    });

    if (mode === 'escalate' && phase === 'args' && !ctx.meta.needsHitl) {
      ctx.meta.needsHitl = true;
      ctx.meta.hitlReason = `High sensitivity data detected (score: ${score}, ${details})`;
    }
  }
}
