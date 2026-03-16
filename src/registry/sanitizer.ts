import { childLogger } from '../util/logger.js';

const log = childLogger('sanitizer');

export const SUSPICIOUS_PATTERNS = [
  /ignore\s+(previous|above|prior)/i,
  /you\s+are\s+/i,
  /new\s+instruction/i,
  /override/i,
  /\[SYSTEM\]/i,
  /system:/i,
];

const MAX_DESCRIPTION_LENGTH = 500;

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

export function sanitizeToolDescription(
  toolName: string,
  description: string | undefined,
  override?: string
): string {
  if (override !== undefined) return override;
  if (!description) return '';

  // Strip suspicious patterns (possible prompt injection from downstream MCPs)
  let cleaned = description;
  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (pattern.test(cleaned)) {
      log.warn(
        { toolName, pattern: pattern.source },
        'Stripping suspicious pattern from tool description (possible prompt injection)'
      );
      cleaned = cleaned.replace(pattern, '[removed]');
    }
  }

  // Truncate
  if (cleaned.length > MAX_DESCRIPTION_LENGTH) {
    return cleaned.slice(0, MAX_DESCRIPTION_LENGTH) + '…';
  }

  return cleaned;
}
