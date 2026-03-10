import { childLogger } from '../util/logger.js';

const log = childLogger('sanitizer');

const SUSPICIOUS_PATTERNS = [
  /ignore\s+(previous|above|prior)/i,
  /you\s+are\s+/i,
  /new\s+instruction/i,
  /override/i,
  /\[SYSTEM\]/i,
  /system:/i,
];

const MAX_DESCRIPTION_LENGTH = 500;

export function sanitizeToolDescription(
  toolName: string,
  description: string | undefined,
  override?: string,
): string {
  if (override !== undefined) return override;
  if (!description) return '';

  // Warn on suspicious patterns
  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (pattern.test(description)) {
      log.warn({ toolName, pattern: pattern.source }, 'Suspicious pattern in tool description (possible prompt injection)');
    }
  }

  // Truncate
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return description.slice(0, MAX_DESCRIPTION_LENGTH) + '…';
  }

  return description;
}
