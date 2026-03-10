import type { AgentConfig } from '../config/schema.js';

const BUILTIN_NAMESPACES = new Set(['http', 'exec']);

/**
 * Return the MCP IDs from `availableMcpIds` that are actually referenced
 * by the agent's allow list. Built-in namespaces (http, exec) are excluded.
 */
export function requiredMcpsForAgent(
  agentConfig: AgentConfig,
  availableMcpIds: string[],
): string[] {
  const available = new Set(availableMcpIds);
  const needed = new Set<string>();

  for (const pattern of agentConfig.allow) {
    const namespace = pattern.split('/')[0];
    if (namespace && !BUILTIN_NAMESPACES.has(namespace) && available.has(namespace)) {
      needed.add(namespace);
    }
  }

  return Array.from(needed);
}
