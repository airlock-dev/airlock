import type { AgentConfig, GatewayConfig, ProfileConfig } from './schema.js';

interface ResolvedPermissions {
  allow: string[];
  ask: string[];
  deny: string[];
  arg_policy?: AgentConfig['arg_policy'];
  arg_scope?: AgentConfig['arg_scope'];
}

type PermissionSource = Pick<ProfileConfig, 'allow' | 'ask' | 'deny' | 'arg_policy' | 'arg_scope'>;

function unionPermissions(...sources: PermissionSource[]): ResolvedPermissions {
  const allow = new Set<string>();
  const ask = new Set<string>();
  const deny = new Set<string>();

  for (const source of sources) {
    for (const p of source.allow) allow.add(p);
    for (const p of source.ask) ask.add(p);
    for (const p of source.deny) deny.add(p);
  }

  return {
    allow: Array.from(allow),
    ask: Array.from(ask),
    deny: Array.from(deny),
    arg_policy: sources.reduce<AgentConfig['arg_policy']>(
      (acc, source) => mergeArgPolicy(acc, source.arg_policy),
      undefined
    ),
    arg_scope: sources.reduce<AgentConfig['arg_scope']>(
      (acc, source) => mergeArgScope(acc, source.arg_scope),
      undefined
    ),
  };
}

function mergeArgPolicy(
  base: AgentConfig['arg_policy'],
  override: AgentConfig['arg_policy']
): AgentConfig['arg_policy'] {
  if (!base && !override) return undefined;
  const result: NonNullable<AgentConfig['arg_policy']> = { ...(base ?? {}) };
  for (const [toolName, policy] of Object.entries(override ?? {})) {
    result[toolName] = { ...(result[toolName] ?? {}), ...policy };
  }
  return result;
}

function mergeArgScope(
  base: AgentConfig['arg_scope'],
  override: AgentConfig['arg_scope']
): AgentConfig['arg_scope'] {
  if (!base && !override) return undefined;
  return { ...(base ?? {}), ...(override ?? {}) };
}

export function resolveProfiles(
  profiles: Record<string, ProfileConfig>
): Record<string, ProfileConfig> {
  const resolved: Record<string, ProfileConfig> = {};
  const resolving = new Set<string>();

  function resolveProfile(profileName: string, path: string[]): ProfileConfig {
    const profile = profiles[profileName];
    if (!profile) {
      const parentName = path.length >= 2 ? path[path.length - 2] : profileName;
      throw new Error(`Profile "${parentName}" extends unknown profile "${profileName}".`);
    }

    if (resolved[profileName]) return resolved[profileName];

    if (resolving.has(profileName)) {
      const cycleStart = path.indexOf(profileName);
      const cyclePath = path.slice(cycleStart >= 0 ? cycleStart : 0).join(' -> ');
      throw new Error(`Profile extends cycle detected: ${cyclePath}.`);
    }

    resolving.add(profileName);
    const inherited = profile.extends.map((parentName) =>
      resolveProfile(parentName, [...path, parentName])
    );
    resolving.delete(profileName);

    const permissions = unionPermissions(...inherited, profile);
    const next: ProfileConfig = {
      ...profile,
      extends: [],
      ...permissions,
    };
    resolved[profileName] = next;
    return next;
  }

  for (const profileName of Object.keys(profiles)) {
    resolveProfile(profileName, [profileName]);
  }

  return resolved;
}

export function resolveAgentPermissions(
  agentConfig: AgentConfig,
  profiles: Record<string, ProfileConfig>
): ResolvedPermissions {
  const inherited = agentConfig.extends.map((profileName) => {
    const profile = profiles[profileName];
    if (!profile) {
      throw new Error(`Agent extends unknown profile "${profileName}".`);
    }
    return profile;
  });

  return unionPermissions(...inherited, agentConfig);
}

export function applyProfiles(config: GatewayConfig): void {
  config.profiles = resolveProfiles(config.profiles);

  for (const agent of Object.values(config.agents)) {
    if (agent.extends.length === 0) continue;

    const resolved = resolveAgentPermissions(agent, config.profiles);
    agent.allow = resolved.allow;
    agent.ask = resolved.ask;
    agent.deny = resolved.deny;
    agent.arg_policy = mergeArgPolicy(resolved.arg_policy, agent.arg_policy);
    agent.arg_scope = mergeArgScope(resolved.arg_scope, agent.arg_scope);
    agent.extends = [];
  }
}
