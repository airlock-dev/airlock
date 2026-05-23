import type { AgentConfig, GatewayConfig } from './schema.js';

interface ResolvedPermissions {
  allow: string[];
  ask: string[];
  deny: string[];
}

export function resolveAgentPermissions(
  agentConfig: AgentConfig,
  profiles: Record<string, { allow: string[]; ask: string[]; deny?: string[] }>
): ResolvedPermissions {
  const allow = new Set<string>();
  const ask = new Set<string>();
  const deny = new Set<string>();

  // Apply profiles in extends order, skipping unknown refs (caught by validateConfig)
  for (const profileName of agentConfig.extends) {
    const profile = profiles[profileName];
    if (profile) {
      for (const p of profile.allow) allow.add(p);
      for (const p of profile.ask) ask.add(p);
      for (const p of profile.deny ?? []) deny.add(p);
    }
  }

  // Union with agent's own allow/ask/deny
  for (const p of agentConfig.allow) allow.add(p);
  for (const p of agentConfig.ask) ask.add(p);
  for (const p of agentConfig.deny) deny.add(p);

  return {
    allow: Array.from(allow),
    ask: Array.from(ask),
    deny: Array.from(deny),
  };
}

export function applyProfiles(config: GatewayConfig): void {
  for (const agent of Object.values(config.agents)) {
    if (agent.extends.length === 0) continue;

    const resolved = resolveAgentPermissions(agent, config.profiles);
    agent.allow = resolved.allow;
    agent.ask = resolved.ask;
    agent.deny = resolved.deny;
    agent.extends = [];
  }
}
