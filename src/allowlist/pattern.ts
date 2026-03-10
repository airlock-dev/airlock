/**
 * Match a tool name against a pattern.
 * Supports:
 *   - Exact match: "github/create_pr"
 *   - Wildcard suffix: "github/*" matches "github/create_pr" but NOT "github2/foo"
 */
export function matches(pattern: string, toolName: string): boolean {
  if (pattern === toolName) return true;

  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -1); // "github/"
    return toolName.startsWith(prefix) && !toolName.slice(prefix.length).includes('/');
  }

  if (pattern.endsWith('*')) {
    // e.g. "git*" — simple prefix match, but must stay within same namespace
    const prefix = pattern.slice(0, -1);
    return toolName.startsWith(prefix);
  }

  return false;
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
