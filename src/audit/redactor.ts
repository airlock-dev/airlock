/**
 * Recursively redact fields matching any of the given patterns (case-insensitive substring match).
 */
export function redactFields(obj: unknown, fieldPatterns: string[]): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map(item => redactFields(item, fieldPatterns));
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (shouldRedact(key, fieldPatterns)) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = redactFields(value, fieldPatterns);
    }
  }
  return result;
}

function shouldRedact(key: string, patterns: string[]): boolean {
  const lower = key.toLowerCase();
  return patterns.some(p => lower.includes(p.toLowerCase()));
}
