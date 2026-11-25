import type { AgentConfig } from '../config/schema.js';
import { matches } from '../allowlist/pattern.js';

const BUILTIN_NAMESPACES = new Set(['http', 'exec']);

/**
 * Return the MCP IDs from `availableMcpIds` that are actually referenced
 * by the agent's allow or ask lists. Built-in namespaces (http, exec) are excluded.
 */
export function requiredMcpsForAgent(
  agentConfig: AgentConfig,
  availableMcpIds: string[]
): string[] {
  const available = new Set(availableMcpIds);
  const needed = new Set<string>();

  // Check tool allow/ask and event allow/ask — either implies the provider will be used
  const patterns = [
    ...agentConfig.allow,
    ...agentConfig.ask,
    ...(agentConfig.events?.allow ?? []),
    ...(agentConfig.events?.ask ?? []),
  ];
  for (const pattern of patterns) {
    const namespace = pattern.split('/')[0];
    if (namespace && !BUILTIN_NAMESPACES.has(namespace) && available.has(namespace)) {
      needed.add(namespace);
    }
  }

  return Array.from(needed);
}

/**
 * Return the set of provider namespaces referenced in any agent's `events.allow` or `events.ask`.
 * Used by `ClientPool` so stdio providers only send the 2026-07-28 `server/discover` probe when
 * an operator has actually granted event access to them — leaving legacy 2025 stdio servers that
 * expect `initialize` as frame #1 completely untouched.
 */
export function eventEnabledProviders(
  agents: Record<string, AgentConfig>,
  availableMcpIds?: string[]
): Set<string> {
  const providers = new Set<string>();
  const patterns: string[] = [];
  for (const agent of Object.values(agents)) {
    patterns.push(...(agent.events?.allow ?? []), ...(agent.events?.ask ?? []));
  }
  for (const pattern of patterns) {
    const namespace = pattern.split('/')[0];
    if (!namespace || BUILTIN_NAMESPACES.has(namespace)) continue;
    if (availableMcpIds && (namespace.includes('*') || !pattern.includes('/'))) {
      for (const id of availableMcpIds) {
        if (BUILTIN_NAMESPACES.has(id)) continue;
        if (matches(namespace, id) || matches(pattern, `${id}/_`)) {
          providers.add(id);
        }
      }
    } else {
      providers.add(namespace);
    }
  }
  return providers;
}
