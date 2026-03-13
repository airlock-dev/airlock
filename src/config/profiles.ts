import type { AgentConfig, GatewayConfig } from './schema.js';

interface ResolvedPermissions {
  allow: string[];
  ask: string[];
}

export function resolveAgentPermissions(
  agentConfig: AgentConfig,
  profiles: Record<string, { allow: string[]; ask: string[] }>,
): ResolvedPermissions {
  const allow = new Set<string>();
  const ask = new Set<string>();

  // Apply profiles in extends order
  for (const profileName of agentConfig.extends) {
    const profile = profiles[profileName];
    if (profile) {
      for (const p of profile.allow) allow.add(p);
      for (const p of profile.ask) ask.add(p);
    }
  }

  // Union with agent's own allow/ask
  for (const p of agentConfig.allow) allow.add(p);
  for (const p of agentConfig.ask) ask.add(p);

  return {
    allow: Array.from(allow),
    ask: Array.from(ask),
  };
}

export function validateProfiles(config: GatewayConfig): void {
  const profileNames = new Set(Object.keys(config.profiles));

  for (const [agentId, agent] of Object.entries(config.agents)) {
    for (const ref of agent.extends) {
      if (!profileNames.has(ref)) {
        throw new Error(`Agent "${agentId}" extends unknown profile "${ref}"`);
      }
    }
  }
}

export function applyProfiles(config: GatewayConfig): void {
  validateProfiles(config);

  for (const agent of Object.values(config.agents)) {
    if (agent.extends.length === 0) continue;

    const resolved = resolveAgentPermissions(agent, config.profiles);
    agent.allow = resolved.allow;
    agent.ask = resolved.ask;
  }
}
