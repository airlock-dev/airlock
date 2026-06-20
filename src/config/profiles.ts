import { isDeepStrictEqual } from 'util';
import type {
  AgentConfig,
  GatewayConfig,
  NormalizerName,
  ProfileConfig,
  ToolArgConstraintConfig,
  ToolArgPolicyConfig,
} from './schema.js';

interface ResolvedPermissions {
  allow: string[];
  ask: string[];
  deny: string[];
  arg_policy?: ToolArgPolicyConfig;
  arg_scope?: Record<string, string[]>;
}

type PermissionSource = Pick<
  ProfileConfig | AgentConfig,
  'allow' | 'ask' | 'deny' | 'arg_policy' | 'arg_scope'
>;

function mergeArgPolicy(
  target: ToolArgPolicyConfig,
  source: ToolArgPolicyConfig | undefined
): ToolArgPolicyConfig {
  if (!source) return target;

  for (const [toolName, policy] of Object.entries(source)) {
    const targetPolicy = (target[toolName] ??= {});
    for (const [argName, constraints] of Object.entries(policy)) {
      targetPolicy[argName] = [...(targetPolicy[argName] ?? []), ...constraints];
    }
  }

  return target;
}

function mergeArgScope(
  target: Record<string, string[]>,
  source: Record<string, string[]> | undefined
): Record<string, string[]> {
  if (!source) return target;

  for (const [dimensionName, valueSetNames] of Object.entries(source)) {
    const targetValueSets = (target[dimensionName] ??= []);
    for (const valueSetName of valueSetNames) {
      if (!targetValueSets.includes(valueSetName)) {
        targetValueSets.push(valueSetName);
      }
    }
  }

  return target;
}

function unionPermissions(...sources: PermissionSource[]): ResolvedPermissions {
  const allow = new Set<string>();
  const ask = new Set<string>();
  const deny = new Set<string>();
  const arg_policy: ToolArgPolicyConfig = {};
  const arg_scope: Record<string, string[]> = {};

  for (const source of sources) {
    for (const p of source.allow) allow.add(p);
    for (const p of source.ask) ask.add(p);
    for (const p of source.deny) deny.add(p);
    mergeArgPolicy(arg_policy, source.arg_policy);
    mergeArgScope(arg_scope, source.arg_scope);
  }

  return {
    allow: Array.from(allow),
    ask: Array.from(ask),
    deny: Array.from(deny),
    ...(Object.keys(arg_policy).length > 0 ? { arg_policy } : {}),
    ...(Object.keys(arg_scope).length > 0 ? { arg_scope } : {}),
  };
}

function toInlineConstraint(
  match: 'in' | 'glob_in' | 'each_in',
  label: string,
  values: unknown[],
  exposeValues: boolean,
  normalize?: NormalizerName[],
  path?: string
): ToolArgConstraintConfig {
  const base = {
    label,
    value_set: label,
    expose_values: exposeValues,
    ...(normalize ? { normalize } : {}),
    ...(path ? { path } : {}),
  };

  if (match === 'glob_in') {
    return { ...base, glob_allow: values.map((value) => String(value)) };
  }

  if (match === 'each_in') {
    return { ...base, each_allow: values };
  }

  return { ...base, allow: values };
}

function pushUnique(values: unknown[], nextValues: unknown[]): void {
  for (const nextValue of nextValues) {
    if (!values.some((value) => isDeepStrictEqual(value, nextValue))) {
      values.push(nextValue);
    }
  }
}

function desugarArgScope(config: GatewayConfig, agent: AgentConfig): ToolArgPolicyConfig {
  const policy: ToolArgPolicyConfig = {};

  for (const [dimensionName, valueSetNames] of Object.entries(agent.arg_scope ?? {})) {
    const dimension = config.arg_dimensions[dimensionName];
    if (!dimension) {
      throw new Error(`arg_scope references unknown arg_dimension "${dimensionName}".`);
    }

    for (const valueSetName of valueSetNames) {
      const valueSet = config.value_sets[valueSetName];
      if (!valueSet) {
        throw new Error(
          `arg_scope.${dimensionName} references unknown value_set "${valueSetName}".`
        );
      }
    }

    const valueSets = valueSetNames.map((valueSetName) => ({
      name: valueSetName,
      config: config.value_sets[valueSetName],
    }));
    const label = valueSets.map(({ name }) => name).join(' + ');
    const exposeValues = valueSets.every(({ config: valueSet }) => valueSet.expose_values);
    const values: unknown[] = [];
    for (const { config: valueSet } of valueSets) {
      pushUnique(values, valueSet.values);
    }

    for (const [toolName, bindingPath] of Object.entries(dimension.bindings)) {
      mergeArgPolicy(policy, {
        [toolName]: {
          [bindingPath]: [
            toInlineConstraint(
              dimension.match,
              label,
              values,
              exposeValues,
              dimension.normalize,
              bindingPath
            ),
          ],
        },
      });
    }
  }

  return policy;
}

function resolveNamedSetConstraint(
  config: GatewayConfig,
  constraint: ToolArgConstraintConfig,
  location: string
): ToolArgConstraintConfig {
  const setRef = constraint.in ?? constraint.glob_in ?? constraint.each_in;
  if (!setRef) return constraint;

  const valueSet = config.value_sets[setRef];
  if (!valueSet) {
    throw new Error(`${location} references unknown value_set "${setRef}".`);
  }

  const base = {
    ...constraint,
    label: constraint.label ?? setRef,
    value_set: setRef,
    expose_values: constraint.expose_values ?? valueSet.expose_values,
  };

  delete base.in;
  delete base.glob_in;
  delete base.each_in;

  if (constraint.glob_in) {
    return { ...base, glob_allow: valueSet.values.map((value) => String(value)) };
  }

  if (constraint.each_in) {
    return { ...base, each_allow: valueSet.values };
  }

  return { ...base, allow: valueSet.values };
}

function resolveNamedSetPolicy(
  config: GatewayConfig,
  policy: ToolArgPolicyConfig | undefined,
  location: string
): ToolArgPolicyConfig | undefined {
  if (!policy) return undefined;

  const resolved: ToolArgPolicyConfig = {};
  for (const [toolName, toolPolicy] of Object.entries(policy)) {
    resolved[toolName] = {};
    for (const [argName, constraints] of Object.entries(toolPolicy)) {
      resolved[toolName][argName] = constraints.map((constraint) =>
        resolveNamedSetConstraint(config, constraint, `${location}.${toolName}.${argName}`)
      );
    }
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
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
    const resolved =
      agent.extends.length === 0
        ? unionPermissions(agent)
        : resolveAgentPermissions(agent, config.profiles);

    for (const [toolName, override] of Object.entries(agent.tool_overrides)) {
      override.args = resolveNamedSetPolicy(
        config,
        { [toolName]: override.args ?? {} },
        `agents.tool_overrides.${toolName}.args`
      )?.[toolName];
    }

    agent.allow = resolved.allow;
    agent.ask = resolved.ask;
    agent.deny = resolved.deny;
    agent.arg_policy = resolveNamedSetPolicy(
      config,
      mergeArgPolicy(
        desugarArgScope(config, { ...agent, arg_scope: resolved.arg_scope }),
        resolved.arg_policy
      ),
      'agents.arg_policy'
    );
    agent.arg_scope = undefined;
    agent.extends = [];
  }
}
