import path from 'path';

export interface NormalizedTool {
  /** Airlock tool name, e.g. "bash/git", "file/edit", "bash/_complex" */
  name: string;
  /** Extracted executable for bash commands, e.g. "git", "npm" */
  executable?: string;
}

/** Shell metacharacters that indicate a non-simple command */
const COMPLEX_COMMAND_RE = /[;|&`$(){}><]/;

/**
 * Tool name mappings per client.
 * Maps external tool names → Airlock namespace/tool format.
 * Unknown tools pass through as-is.
 */
const CLIENT_TOOL_MAPS: Record<string, Record<string, string>> = {
  'claude-code': {
    Bash: 'bash',
    Edit: 'file/edit',
    Read: 'file/read',
    Write: 'file/write',
    Glob: 'file/glob',
    Grep: 'file/grep',
    WebFetch: 'http/fetch',
    WebSearch: 'http/search',
    Agent: 'agent/spawn',
    TodoRead: 'todo/read',
    TodoWrite: 'todo/write',
    NotebookEdit: 'notebook/edit',
  },
};

/**
 * Check if a command string is "simple" — a single command with no
 * shell metacharacters that could chain or inject additional commands.
 */
export function isSimpleCommand(command: string): boolean {
  return !COMPLEX_COMMAND_RE.test(command);
}

/**
 * Extract the executable name from a simple command string.
 * Handles path-prefixed commands (e.g. /usr/bin/git → git)
 * and leading env vars (e.g. FOO=bar git status → git).
 */
export function extractExecutable(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  const tokens = trimmed.split(/\s+/);

  // Skip leading env var assignments (KEY=VALUE)
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_]\w*=/.test(tokens[i])) {
    i++;
  }

  const exe = tokens[i];
  if (!exe) return null;

  return path.basename(exe);
}

/**
 * Normalize an external tool name into Airlock's namespaced format.
 *
 * For bash/shell tools, inspects the command to produce fine-grained
 * names like "bash/git", "bash/npm", or "bash/_complex" for commands
 * with shell metacharacters.
 */
export function normalizeTool(
  client: string,
  tool: string,
  input: Record<string, unknown>
): NormalizedTool {
  const mapping = CLIENT_TOOL_MAPS[client] ?? {};
  const mapped = mapping[tool];

  // No mapping → pass through as-is (e.g. mcp__server__tool)
  if (mapped === undefined) {
    return { name: tool };
  }

  // Non-bash tools → return the mapped name directly
  if (mapped !== 'bash') {
    return { name: mapped };
  }

  // Bash tool — inspect the command for granular matching
  const command = typeof input.command === 'string' ? input.command : '';

  if (!command.trim()) {
    return { name: 'bash/_empty' };
  }

  if (!isSimpleCommand(command)) {
    return { name: 'bash/_complex', executable: undefined };
  }

  const exe = extractExecutable(command);
  if (!exe) {
    return { name: 'bash/_complex' };
  }

  return { name: `bash/${exe}`, executable: exe };
}
