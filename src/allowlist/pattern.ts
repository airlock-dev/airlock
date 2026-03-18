/**
 * Match a tool name against a pattern.
 * Supports:
 *   - Exact match: "github/create_pr"
 *   - Wildcard suffix: "github/*" matches "github/create_pr" but NOT "github2/foo"
 */
export function matches(pattern: string, toolName: string): boolean {
  return specificity(pattern, toolName) >= 0;
}

/**
 * Return the specificity of a pattern match, or -1 if no match.
 * Higher values = more specific. Used to resolve conflicts between
 * ask and allow tiers — the most specific matching pattern wins.
 *
 *   Exact match:  pattern.length + 1  (always beats wildcards of same length)
 *   Wildcard:     length of the non-wildcard prefix
 *   No match:     -1
 */
export function specificity(pattern: string, toolName: string): number {
  if (pattern === toolName) return pattern.length + 1;

  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -1); // "github/"
    if (toolName.startsWith(prefix) && !toolName.slice(prefix.length).includes('/')) {
      return prefix.length;
    }
    return -1;
  }

  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    if (toolName.startsWith(prefix)) return prefix.length;
    return -1;
  }

  return -1;
}

/**
 * Find the highest specificity among all matching patterns, or -1 if none match.
 */
export function bestSpecificity(patterns: string[], toolName: string): number {
  let best = -1;
  for (const p of patterns) {
    const s = specificity(p, toolName);
    if (s > best) best = s;
  }
  return best;
}

/**
 * Match a command string against a pattern.
 * Supports glob-style prefix matching with '*'.
 */
export function matchesCommand(pattern: string, command: string): boolean {
  if (pattern === command) return true;
  if (pattern.endsWith('*')) {
    return command.startsWith(pattern.slice(0, -1));
  }
  return false;
}
