import { childLogger } from '../util/logger.js';

const log = childLogger('sanitizer');

export const SUSPICIOUS_PATTERNS = [
  /ignore\s+(previous|above|prior)\s+(instructions?|messages?|context|prompt)/i,
  /you\s+are\s+(now\s+)?(a|an)\s+.*\b(ai|assistant|chatbot|system)\b/i,
  /new\s+instructions?\s*:/i,
  /override\s+(all\s+)?((previous|above|prior|system|developer)\s+)?instructions?/i,
  /\[(system|developer)\]/i,
  /^\s*(system|developer)\s*:/im,
];

const MAX_DESCRIPTION_LENGTH = 500;

/**
 * Server-level instructions are prose meant to orient an agent to a whole provider, so they get a
 * larger budget than a single tool description — but still bounded, since this text lands in every
 * agent's context at initialize and an unbounded upstream string is a denial-of-context vector.
 */
const MAX_INSTRUCTIONS_LENGTH = 4000;

/** Returns the source strings of any suspicious patterns found in the description. */
export function checkSuspiciousPatterns(description: string): string[] {
  const matched: string[] = [];
  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (pattern.test(description)) {
      matched.push(pattern.source);
    }
  }
  return matched;
}

/** Strips known prompt-injection shapes from untrusted upstream text. */
function stripSuspicious(text: string, logContext: Record<string, unknown>): string {
  let cleaned = text;
  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (pattern.test(cleaned)) {
      log.warn(
        { ...logContext, pattern: pattern.source },
        'Stripping suspicious pattern from upstream text (possible prompt injection)'
      );
      cleaned = cleaned.replace(pattern, '[removed]');
    }
  }
  return cleaned;
}

/**
 * Builds the description an agent sees for a tool.
 *
 * `override` and `append` come from operator-authored config (`tool_overrides`), so they are trusted:
 * they are neither scrubbed nor truncated. Only the upstream `description` is untrusted. `override`
 * replaces the upstream text entirely; `append` adds to whatever survived, which is what you want for
 * "keep the vendor's docs, add our house rules" without restating the vendor's docs by hand.
 */
export function sanitizeToolDescription(
  toolName: string,
  description: string | undefined,
  override?: string,
  append?: string
): string {
  let base: string;
  if (override !== undefined) {
    base = override;
  } else if (!description) {
    base = '';
  } else {
    base = stripSuspicious(description, { toolName });
    if (base.length > MAX_DESCRIPTION_LENGTH) {
      base = base.slice(0, MAX_DESCRIPTION_LENGTH) + '…';
    }
  }

  const extra = append?.trim();
  if (!extra) return base;
  return base ? `${base}\n\n${extra}` : extra;
}

/**
 * Scrubs server-level `instructions` advertised by an upstream MCP provider.
 *
 * This text is provider-controlled and lands directly in the agent's context, so it is treated with
 * the same suspicion as a tool description. Returns undefined when there is nothing usable left.
 */
export function sanitizeInstructions(
  providerId: string,
  instructions: string | undefined
): string | undefined {
  const trimmed = instructions?.trim();
  if (!trimmed) return undefined;

  let cleaned = stripSuspicious(trimmed, { providerId });
  if (cleaned.length > MAX_INSTRUCTIONS_LENGTH) {
    log.warn({ providerId, length: cleaned.length }, 'Truncating oversized upstream instructions');
    cleaned = cleaned.slice(0, MAX_INSTRUCTIONS_LENGTH) + '…';
  }
  return cleaned;
}
