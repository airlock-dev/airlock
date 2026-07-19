import { readFileSync } from 'fs';
import { isIP } from 'net';
import { parse as parseYaml } from 'yaml';
import { GatewayConfig, getBuiltinProviders, withEnvVarResolution } from './schema.js';
import { applyProfiles } from './profiles.js';
import { matches } from '../allowlist/pattern.js';
import { AIRLOCK_NON_ASK_TOOLS } from '../airlock/tools.js';
import { childLogger } from '../util/logger.js';
import type { z } from 'zod';

const log = childLogger('config');

export type Config = z.infer<typeof GatewayConfig>;

export interface ConfigDiagnostic {
  level: 'error' | 'warn' | 'info';
  code?: 'unknown-profile-ref' | 'unknown-arg-dimension-ref' | 'unknown-value-set-ref';
  agent?: string;
  message: string;
  suggestion?: string;
}

export interface LoadConfigOptions {
  strict?: boolean;
  resolveEnv?: boolean;
}

export interface LoadConfigResult {
  config?: Config;
  rawConfig?: Config;
  diagnostics: ConfigDiagnostic[];
}

export function loadConfigDetailed(
  path: string,
  options: LoadConfigOptions = {}
): LoadConfigResult {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    return {
      diagnostics: [
        {
          level: 'error',
          message: `Could not read config at ${path}: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    return {
      diagnostics: [
        {
          level: 'error',
          message: `Invalid YAML at ${path}: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }

  const diagnostics = findUnknownKeyDiagnostics(parsed);
  const resolveEnv = options.resolveEnv ?? true;
  let result: ReturnType<typeof GatewayConfig.safeParse>;
  try {
    result = withEnvVarResolution(resolveEnv, () => GatewayConfig.safeParse(parsed));
  } catch (err) {
    diagnostics.push({
      level: 'error',
      message: `Invalid config at ${path}:\n${err instanceof Error ? err.message : String(err)}`,
      suggestion: resolveEnv
        ? 'Set the referenced environment variable, or run config check with --no-resolve for structural validation without secrets.'
        : undefined,
    });
    return { diagnostics: dedupeDiagnostics(diagnostics) };
  }
  if (!result.success) {
    diagnostics.push({
      level: 'error',
      message: `Invalid config at ${path}:\n${result.error.toString()}`,
    });
    return { diagnostics: dedupeDiagnostics(diagnostics) };
  }

  const rawConfig = structuredClone(result.data);

  diagnostics.push(...validateConfig(result.data));
  diagnostics.push(...validateRawArgDimensionUsage(result.data));
  diagnostics.push(...validateYamlScalarFootguns(result.data));

  if (!diagnostics.some((diagnostic) => diagnostic.level === 'error')) {
    try {
      applyProfiles(result.data);
    } catch (err) {
      diagnostics.push({
        level: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!diagnostics.some((diagnostic) => diagnostic.level === 'error')) {
    diagnostics.push(...validateConfig(result.data));
    diagnostics.push(...validateEffectiveArgRestrictions(rawConfig, result.data));
  }

  return {
    config: result.data,
    rawConfig,
    diagnostics: dedupeDiagnostics(diagnostics),
  };
}

export function loadConfig(path: string, options: LoadConfigOptions = {}): Config {
  const result = loadConfigDetailed(path, options);
  for (const d of result.diagnostics) {
    const ctx = d.agent ? { agent: d.agent } : {};
    const msg = d.suggestion ? `${d.message}\n  → ${d.suggestion}` : d.message;
    if (d.level === 'error') {
      log.error(ctx, msg);
    } else if (d.level === 'warn') {
      log.warn(ctx, msg);
    } else {
      log.info(ctx, msg);
    }
  }
  const errors = result.diagnostics.filter((d) => d.level === 'error');
  if (errors.length > 0) {
    throw new Error(
      `Config validation failed with ${errors.length} error(s):\n` +
        errors.map((e) => `  - ${e.agent ? `[${e.agent}] ` : ''}${e.message}`).join('\n')
    );
  }
  if (!result.config) {
    throw new Error(`Config validation failed without a parsed config.`);
  }
  return result.config;
}

export function validateConfig(config: Config): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];
  const providerNames = new Set(Object.keys(config.providers));
  const builtins = getBuiltinProviders(config.providers);

  const profileNames = new Set(Object.keys(config.profiles));
  const sandboxPresetNames = new Set(Object.keys(config.sandbox_presets ?? {}));

  const serverHost = config.server.host;
  const isLoopback = isLoopbackHost(serverHost);
  const managementApiEnabled = config.server.management_api.enabled;
  const managementApiSecret = config.server.management_api.api_secret;
  const agentsWithoutTokens = Object.entries(config.agents)
    .filter(([, agent]) => !agent.token)
    .map(([agentId]) => agentId);
  const requireAgentTokens =
    config.server.require_agent_tokens || !isLoopback || managementApiEnabled;

  if (config.server.expose_management_api !== undefined) {
    diagnostics.push({
      level: 'warn',
      message: 'server.expose_management_api is deprecated.',
      suggestion: 'Use server.management_api.enabled instead.',
    });
  }

  if (config.server.expose_hook_api !== undefined) {
    diagnostics.push({
      level: 'warn',
      message: 'server.expose_hook_api is deprecated.',
      suggestion: 'Use server.management_api.expose_hook_api instead.',
    });
  }

  if (!isLoopback && !config.server.auth_required) {
    diagnostics.push({
      level: 'error',
      message: 'server.auth_required must be true when server.host is not loopback.',
      suggestion:
        'Set server.auth_required: true, configure server.api_secret or per-agent tokens, and put Airlock behind TLS.',
    });
  }

  if (requireAgentTokens && agentsWithoutTokens.length > 0) {
    diagnostics.push({
      level: 'error',
      message: 'Per-agent tokens are required, but some agents have no token.',
      suggestion: `Add token to agents: ${agentsWithoutTokens.join(', ')}. Per-agent tokens are required for non-loopback data-plane binds, explicit server.require_agent_tokens, and split management API mode.`,
    });
  }

  if (config.server.auth_required) {
    if (!config.server.api_secret && agentsWithoutTokens.length > 0) {
      diagnostics.push({
        level: 'error',
        message:
          'server.auth_required is true, but server.api_secret is unset and some agents have no token.',
        suggestion: `Set server.api_secret or add token to agents: ${agentsWithoutTokens.join(', ')}.`,
      });
    }

    if (!managementApiSecret && !config.server.api_secret && managementApiEnabled) {
      diagnostics.push({
        level: 'error',
        message:
          'server.auth_required is true, but the control-plane management API is enabled without a credential.',
        suggestion:
          'Set server.management_api.api_secret, set server.api_secret as a temporary fallback, or disable server.management_api.enabled.',
      });
    }
  }

  if (managementApiEnabled && !managementApiSecret && !config.server.api_secret) {
    diagnostics.push({
      level: 'error',
      message:
        'server.management_api.enabled requires server.management_api.api_secret or server.api_secret.',
      suggestion:
        'Set server.management_api.api_secret so control-plane requests require bearer-token auth.',
    });
  }

  if (managementApiEnabled && !managementApiSecret && config.server.api_secret) {
    diagnostics.push({
      level: 'warn',
      message:
        'management_api is using server.api_secret; set server.management_api.api_secret to separate the control-plane secret from the data-plane fallback.',
      suggestion:
        'Generate a fresh management secret, set server.management_api.api_secret, and update management clients to use it.',
    });
  }

  if (
    managementApiEnabled &&
    managementApiSecret &&
    config.server.api_secret &&
    managementApiSecret === config.server.api_secret
  ) {
    diagnostics.push({
      level: 'warn',
      message:
        'server.management_api.api_secret matches server.api_secret; rotate one secret to separate the control-plane credential from the data-plane fallback.',
      suggestion:
        'Use different resolved values for server.management_api.api_secret and server.api_secret.',
    });
  }

  if (
    managementApiEnabled &&
    !isLoopbackHost(config.server.management_api.host) &&
    !config.server.management_api.insecure_remote_bind
  ) {
    diagnostics.push({
      level: 'error',
      message: 'server.management_api.host is non-loopback while insecure_remote_bind is false.',
      suggestion:
        'Keep server.management_api.host on 127.0.0.1/::1, or explicitly set server.management_api.insecure_remote_bind: true and restrict the control-plane port with network ACLs.',
    });
  }

  if (managementApiEnabled && config.server.management_api.port === config.server.port) {
    diagnostics.push({
      level: 'error',
      message: 'Control-plane and data-plane must not share a socket.',
      suggestion:
        'Set server.management_api.port to a different port than server.port so admin/audit/approval routes cannot co-host with agent MCP routes.',
    });
  }

  if (config.default_profile && !profileNames.has(config.default_profile)) {
    diagnostics.push({
      level: 'error',
      code: 'unknown-profile-ref',
      message: `default_profile references unknown profile "${config.default_profile}".`,
      suggestion: `Add "${config.default_profile}" to your profiles block, or check for typos.`,
    });
  }

  for (const [agentId, agent] of Object.entries(config.agents)) {
    // Check for unknown profile references
    for (const ref of agent.extends) {
      if (!profileNames.has(ref)) {
        diagnostics.push({
          level: 'error',
          code: 'unknown-profile-ref',
          agent: agentId,
          message: `extends references unknown profile "${ref}".`,
          suggestion: `Add "${ref}" to your profiles block, or check for typos.`,
        });
      }
    }

    diagnostics.push(
      ...validateArgScopeRefs(config, agent.arg_scope, `agents.${agentId}.arg_scope`, agentId)
    );
    diagnostics.push(
      ...validateArgPolicyRefs(config, agent.arg_policy, `agents.${agentId}.arg_policy`, agentId)
    );

    for (const presetName of agent.sandbox.presets) {
      if (!sandboxPresetNames.has(presetName)) {
        diagnostics.push({
          level: 'error',
          agent: agentId,
          message: `sandbox.presets references unknown sandbox preset "${presetName}".`,
          suggestion: `Add "${presetName}" to the top-level sandbox_presets block, or check for typos.`,
        });
      }
    }

    for (const [toolName, override] of Object.entries(agent.tool_overrides)) {
      diagnostics.push(
        ...validateArgPolicyRefs(
          config,
          override.args ? { [toolName]: override.args } : undefined,
          `agents.${agentId}.tool_overrides.${toolName}.args`,
          agentId
        )
      );
      for (const presetName of override.sandbox_presets ?? []) {
        if (!sandboxPresetNames.has(presetName)) {
          diagnostics.push({
            level: 'error',
            agent: agentId,
            message: `tool_overrides.${toolName}.sandbox_presets references unknown sandbox preset "${presetName}".`,
            suggestion: `Add "${presetName}" to the top-level sandbox_presets block, or check for typos.`,
          });
        }
      }
    }

    // Collect all referenced namespaces from allow/ask/deny
    const allPatterns = [...agent.allow, ...agent.ask, ...agent.deny];
    const referencedNamespaces = new Set<string>();
    const toolOverrideNamespaces = new Set(
      Object.keys(agent.tool_overrides)
        .map((toolName) => toolName.split('/')[0])
        .filter((namespace): namespace is string => !!namespace)
    );

    for (const pattern of allPatterns) {
      const ns = pattern.split('/')[0];
      if (ns) referencedNamespaces.add(ns);
    }

    // Check for unknown providers
    for (const ns of referencedNamespaces) {
      if (!providerNames.has(ns) && !toolOverrideNamespaces.has(ns)) {
        diagnostics.push({
          level: 'error',
          agent: agentId,
          message: `Pattern references unknown provider "${ns}".`,
          suggestion: `Add "${ns}" to your providers block, or check for typos.`,
        });
      }
    }

    // Check for shadowed rules: allow pattern also matched by deny
    for (const allowPattern of agent.allow) {
      for (const denyPattern of agent.deny) {
        if (
          matches(denyPattern, allowPattern) ||
          matches(allowPattern, denyPattern) ||
          patternsOverlap(allowPattern, denyPattern)
        ) {
          diagnostics.push({
            level: 'warn',
            agent: agentId,
            message: `"${allowPattern}" in allow is shadowed by "${denyPattern}" in deny — deny always wins.`,
            suggestion: `Remove "${allowPattern}" from allow, or narrow the deny pattern.`,
          });
        }
      }
    }

    // Check for unreachable ask: ask pattern also matched by deny
    for (const askPattern of agent.ask) {
      const forbiddenAirlockTool = AIRLOCK_NON_ASK_TOOLS.find((tool) => matches(askPattern, tool));
      if (forbiddenAirlockTool) {
        diagnostics.push({
          level: 'error',
          agent: agentId,
          message: `"${askPattern}" puts ${forbiddenAirlockTool} behind ask, which is not allowed.`,
          suggestion:
            'Move Airlock human-attention tools to allow or deny. They cannot require approval without creating recursive approval.',
        });
      }

      for (const denyPattern of agent.deny) {
        if (
          matches(denyPattern, askPattern) ||
          matches(askPattern, denyPattern) ||
          patternsOverlap(askPattern, denyPattern)
        ) {
          diagnostics.push({
            level: 'warn',
            agent: agentId,
            message: `"${askPattern}" in ask is shadowed by "${denyPattern}" in deny — approval will never be requested.`,
            suggestion: `Remove "${askPattern}" from ask, or narrow the deny pattern.`,
          });
        }
      }
    }

    // Check exec command routing without exec provider
    const hasExecPatterns = agent.exec.allow.length > 0 || agent.exec.ask.length > 0;
    if (hasExecPatterns && !builtins.has('exec')) {
      diagnostics.push({
        level: 'warn',
        agent: agentId,
        message: 'exec command patterns defined but "exec" is not declared as a provider.',
        suggestion: 'Add exec: builtin to your providers block.',
      });
    }

    // Check exec deny-all with other exec patterns
    const hasCatchAllDeny = agent.exec.deny.some((p) => p === '*');
    if (hasCatchAllDeny && (agent.exec.allow.length > 0 || agent.exec.ask.length > 0)) {
      diagnostics.push({
        level: 'warn',
        agent: agentId,
        message: 'exec.deny contains "*" which overrides all exec.allow and exec.ask patterns.',
        suggestion: 'Remove deny: ["*"] and rely on fail-closed behavior instead.',
      });
    }

    // Check empty agent
    if (agent.extends.length === 0 && agent.allow.length === 0 && agent.ask.length === 0) {
      diagnostics.push({
        level: 'info',
        agent: agentId,
        message: 'Agent has no allow or ask rules — all tools will be denied.',
      });
    }

    // Check http domain_allowlist without http provider
    if (agent.http.domain_allowlist.length > 0 && !builtins.has('http')) {
      diagnostics.push({
        level: 'warn',
        agent: agentId,
        message: 'http.domain_allowlist configured but "http" is not declared as a provider.',
        suggestion: 'Add http: builtin to your providers block.',
      });
    }
  }

  for (const [profileId, profile] of Object.entries(config.profiles)) {
    for (const ref of profile.extends) {
      if (!profileNames.has(ref)) {
        diagnostics.push({
          level: 'error',
          code: 'unknown-profile-ref',
          message: `Profile "${profileId}" extends unknown profile "${ref}".`,
          suggestion: `Add "${ref}" to your profiles block, or check for typos.`,
        });
      }
    }
    diagnostics.push(
      ...validateArgScopeRefs(config, profile.arg_scope, `profiles.${profileId}.arg_scope`)
    );
    diagnostics.push(
      ...validateArgPolicyRefs(config, profile.arg_policy, `profiles.${profileId}.arg_policy`)
    );
    for (const [toolName, override] of Object.entries(profile.tool_overrides)) {
      diagnostics.push(
        ...validateArgPolicyRefs(
          config,
          override.args ? { [toolName]: override.args } : undefined,
          `profiles.${profileId}.tool_overrides.${toolName}.args`
        )
      );
      for (const presetName of override.sandbox_presets ?? []) {
        if (!sandboxPresetNames.has(presetName)) {
          diagnostics.push({
            level: 'error',
            message: `profiles.${profileId}.tool_overrides.${toolName}.sandbox_presets references unknown sandbox preset "${presetName}".`,
            suggestion: `Add "${presetName}" to the top-level sandbox_presets block, or check for typos.`,
          });
        }
      }
    }
  }

  // Validate CLI configs
  for (const [cliId, cli] of Object.entries(config.clis)) {
    for (const [cmdName, cmd] of Object.entries(cli.commands)) {
      const templateParams = new Set<string>();
      cmd.exec.replace(/\{(\w+)\}/g, (_, name: string) => {
        templateParams.add(name);
        return '';
      });

      for (const [paramName, param] of Object.entries(cmd.params)) {
        const inTemplate = templateParams.has(paramName);
        const hasFlag = !!param.flag;
        const isPositional = param.positional;

        if (!inTemplate && !hasFlag && !isPositional) {
          diagnostics.push({
            level: 'warn',
            message: `clis.${cliId}.commands.${cmdName}: param "${paramName}" has no flag, is not positional, and is not referenced in exec template — it will be ignored at runtime.`,
            suggestion: `Add a "flag" (e.g. "--${paramName}"), set "positional: true", or reference it as {${paramName}} in the exec string.`,
          });
        }
      }
    }
  }

  return diagnostics;
}

function validateArgScopeRefs(
  config: Config,
  argScope: Record<string, string[]> | undefined,
  location: string,
  agent?: string
): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];
  if (!argScope) return diagnostics;

  const providerNames = new Set(Object.keys(config.providers));
  for (const [dimensionName, valueSetNames] of Object.entries(argScope)) {
    const dimension = config.arg_dimensions[dimensionName];
    if (!dimension) {
      diagnostics.push({
        level: 'error',
        code: 'unknown-arg-dimension-ref',
        agent,
        message: `${location} references unknown arg_dimension "${dimensionName}".`,
        suggestion: `Add "${dimensionName}" to arg_dimensions, or check for typos.`,
      });
      continue;
    }

    for (const valueSetName of valueSetNames) {
      if (!config.value_sets[valueSetName]) {
        diagnostics.push({
          level: 'error',
          code: 'unknown-value-set-ref',
          agent,
          message: `${location}.${dimensionName} references unknown value_set "${valueSetName}".`,
          suggestion: `Add "${valueSetName}" to value_sets, or check for typos.`,
        });
      }
    }

    for (const toolName of Object.keys(dimension.bindings)) {
      const providerName = toolName.split('/')[0];
      if (providerName && !providerNames.has(providerName)) {
        diagnostics.push({
          level: 'warn',
          agent,
          message: `arg_dimensions.${dimensionName}.bindings references tool "${toolName}" from unknown provider "${providerName}".`,
          suggestion:
            'Declare the provider, remove the binding, or leave it only if this config fragment is merged with providers elsewhere.',
        });
      }
    }
  }

  return diagnostics;
}

function validateArgPolicyRefs(
  config: Config,
  argPolicy: Config['agents'][string]['arg_policy'],
  location: string,
  agent?: string
): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];
  if (!argPolicy) return diagnostics;

  for (const [toolName, toolPolicy] of Object.entries(argPolicy)) {
    for (const [argName, constraints] of Object.entries(toolPolicy)) {
      for (const constraint of constraints) {
        const valueSetName = constraint.in ?? constraint.glob_in ?? constraint.each_in;
        if (valueSetName && !config.value_sets[valueSetName]) {
          diagnostics.push({
            level: 'error',
            code: 'unknown-value-set-ref',
            agent,
            message: `${location}.${toolName}.${argName} references unknown value_set "${valueSetName}".`,
            suggestion: `Add "${valueSetName}" to value_sets, or check for typos.`,
          });
        }
      }
    }
  }

  return diagnostics;
}

function validateRawArgDimensionUsage(config: Config): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];
  const usedDimensions = new Set<string>();

  for (const [dimensionName, dimension] of Object.entries(config.arg_dimensions)) {
    if (Object.keys(dimension.bindings).length === 0) {
      diagnostics.push({
        level: 'warn',
        message: `arg_dimensions.${dimensionName}.bindings is empty.`,
        suggestion:
          'Add at least one tool-to-argument binding, or remove the dimension so arg_scope cannot resolve to a no-op.',
      });
    }
  }

  for (const agentName of Object.keys(config.agents)) {
    for (const dimensionName of collectAgentArgScopeDimensions(config, agentName)) {
      usedDimensions.add(dimensionName);
    }
  }

  for (const dimensionName of Object.keys(config.arg_dimensions)) {
    if (!usedDimensions.has(dimensionName)) {
      diagnostics.push({
        level: 'warn',
        message: `arg_dimensions.${dimensionName} is not used by any scoped agent.`,
        suggestion:
          'Attach it through an agent arg_scope or through a profile that at least one agent extends.',
      });
    }
  }

  return diagnostics;
}

function validateEffectiveArgRestrictions(
  rawConfig: Config,
  resolvedConfig: Config
): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];

  for (const [agentName, resolvedAgent] of Object.entries(resolvedConfig.agents)) {
    const sources = collectAgentArgRestrictionSources(rawConfig, agentName);
    if (sources.length === 0) continue;

    if (countArgPolicyConstraints(resolvedAgent.arg_policy) === 0) {
      diagnostics.push({
        level: 'error',
        agent: agentName,
        message: `Agent declares arg_scope/arg_policy via ${sources.join(', ')} but resolves to zero effective argument constraints.`,
        suggestion:
          'Check that arg_scope dimensions have bindings and referenced value_sets, or remove the no-op restriction.',
      });
    }
  }

  return diagnostics;
}

function validateYamlScalarFootguns(config: Config): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];
  const stringMatchedValueSets = collectStringMatchedValueSets(config);

  for (const [valueSetName, locations] of stringMatchedValueSets) {
    const valueSet = config.value_sets[valueSetName];
    if (!valueSet) continue;

    valueSet.values.forEach((value, index) => {
      if (!isUnquotedStringFootgun(value)) return;
      diagnostics.push({
        level: 'warn',
        message: `value_sets.${valueSetName}[${index}] value ${String(value)} looks like an unquoted string while used by ${locations.join(', ')}.`,
        suggestion: `Quote it (${quoteSuggestion(value)}) if it should match string tool arguments.`,
      });
    });
  }

  for (const source of collectArgPolicySources(config)) {
    for (const [toolName, toolPolicy] of Object.entries(source.policy ?? {})) {
      for (const [argName, constraints] of Object.entries(toolPolicy)) {
        for (const constraint of constraints) {
          if (!usesStringNormalizer(constraint.normalize)) continue;
          const values = constraint.allow ?? constraint.each_allow;
          if (!values) continue;

          values.forEach((value, index) => {
            if (!isUnquotedStringFootgun(value)) return;
            diagnostics.push({
              level: 'warn',
              agent: source.agent,
              message: `${source.location}.${toolName}.${argName}[${index}] value ${String(value)} looks like an unquoted string while used with normalize: ${constraint.normalize?.join(', ')}.`,
              suggestion: `Quote it (${quoteSuggestion(value)}) so string normalization can apply before matching.`,
            });
          });
        }
      }
    }
  }

  return diagnostics;
}

function collectAgentArgScopeDimensions(config: Config, agentName: string): string[] {
  const agent = config.agents[agentName];
  if (!agent) return [];

  const dimensions = new Set<string>();
  const visitedProfiles = new Set<string>();

  function visitProfile(profileName: string): void {
    if (visitedProfiles.has(profileName)) return;
    visitedProfiles.add(profileName);
    const profile = config.profiles[profileName];
    if (!profile) return;
    for (const parentName of profile.extends) visitProfile(parentName);
    for (const dimensionName of Object.keys(profile.arg_scope ?? {})) dimensions.add(dimensionName);
  }

  for (const profileName of agent.extends) visitProfile(profileName);
  for (const dimensionName of Object.keys(agent.arg_scope ?? {})) dimensions.add(dimensionName);

  return Array.from(dimensions);
}

function collectAgentArgRestrictionSources(config: Config, agentName: string): string[] {
  const agent = config.agents[agentName];
  if (!agent) return [];

  const sources: string[] = [];
  const visitedProfiles = new Set<string>();

  function visitProfile(profileName: string): void {
    if (visitedProfiles.has(profileName)) return;
    visitedProfiles.add(profileName);
    const profile = config.profiles[profileName];
    if (!profile) return;
    for (const parentName of profile.extends) visitProfile(parentName);
    if (profile.arg_scope) sources.push(`profiles.${profileName}.arg_scope`);
    if (profile.arg_policy) sources.push(`profiles.${profileName}.arg_policy`);
  }

  for (const profileName of agent.extends) visitProfile(profileName);
  if (agent.arg_scope) sources.push(`agents.${agentName}.arg_scope`);
  if (agent.arg_policy) sources.push(`agents.${agentName}.arg_policy`);

  return sources;
}

function countArgPolicyConstraints(argPolicy: Config['agents'][string]['arg_policy']): number {
  let count = 0;
  for (const toolPolicy of Object.values(argPolicy ?? {})) {
    for (const constraints of Object.values(toolPolicy)) {
      count += constraints.length;
    }
  }
  return count;
}

function collectStringMatchedValueSets(config: Config): Map<string, string[]> {
  const valueSets = new Map<string, string[]>();

  function add(valueSetName: string | undefined, location: string): void {
    if (!valueSetName) return;
    const locations = valueSets.get(valueSetName) ?? [];
    if (!locations.includes(location)) locations.push(location);
    valueSets.set(valueSetName, locations);
  }

  for (const [agentName, agent] of Object.entries(config.agents)) {
    collectArgScopeValueSets(config, agent.arg_scope, `agents.${agentName}.arg_scope`, add);
  }

  for (const [profileName, profile] of Object.entries(config.profiles)) {
    collectArgScopeValueSets(config, profile.arg_scope, `profiles.${profileName}.arg_scope`, add);
  }

  for (const source of collectArgPolicySources(config)) {
    for (const [toolName, toolPolicy] of Object.entries(source.policy ?? {})) {
      for (const [argName, constraints] of Object.entries(toolPolicy)) {
        for (const constraint of constraints) {
          add(constraint.in, `${source.location}.${toolName}.${argName}.in`);
          add(constraint.glob_in, `${source.location}.${toolName}.${argName}.glob_in`);
          if (usesStringNormalizer(constraint.normalize)) {
            add(constraint.each_in, `${source.location}.${toolName}.${argName}.each_in`);
          }
        }
      }
    }
  }

  return valueSets;
}

function collectArgScopeValueSets(
  config: Config,
  argScope: Record<string, string[]> | undefined,
  location: string,
  add: (valueSetName: string | undefined, location: string) => void
): void {
  for (const [dimensionName, valueSetNames] of Object.entries(argScope ?? {})) {
    const dimension = config.arg_dimensions[dimensionName];
    const stringMatched =
      dimension?.match === 'in' ||
      dimension?.match === 'glob_in' ||
      usesStringNormalizer(dimension?.normalize);
    if (!stringMatched) continue;
    for (const valueSetName of valueSetNames) {
      add(valueSetName, `${location}.${dimensionName}`);
    }
  }
}

function collectArgPolicySources(config: Config): {
  location: string;
  agent?: string;
  policy: Config['agents'][string]['arg_policy'];
}[] {
  const sources: {
    location: string;
    agent?: string;
    policy: Config['agents'][string]['arg_policy'];
  }[] = [];

  for (const [agentName, agent] of Object.entries(config.agents)) {
    sources.push({
      location: `agents.${agentName}.arg_policy`,
      agent: agentName,
      policy: agent.arg_policy,
    });
    for (const [toolName, override] of Object.entries(agent.tool_overrides)) {
      if (!override.args) continue;
      sources.push({
        location: `agents.${agentName}.tool_overrides.${toolName}.args`,
        agent: agentName,
        policy: { [toolName]: override.args },
      });
    }
  }

  for (const [profileName, profile] of Object.entries(config.profiles)) {
    sources.push({ location: `profiles.${profileName}.arg_policy`, policy: profile.arg_policy });
  }

  return sources;
}

function usesStringNormalizer(normalizers: string[] | undefined): boolean {
  return !!normalizers?.some((normalizer) =>
    ['phone', 'email', 'lower', 'trim'].includes(normalizer)
  );
}

function isUnquotedStringFootgun(value: unknown): value is number | boolean {
  return typeof value === 'number' || typeof value === 'boolean';
}

function quoteSuggestion(value: number | boolean): string {
  if (typeof value === 'number' && Number.isInteger(value) && value > 1_000_000_000) {
    return `"+${value}"`;
  }
  return `"${String(value)}"`;
}

function dedupeDiagnostics(diagnostics: ConfigDiagnostic[]): ConfigDiagnostic[] {
  const seen = new Set<string>();
  const result: ConfigDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.level}\0${diagnostic.agent ?? ''}\0${diagnostic.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(diagnostic);
  }
  return result;
}

// Unknown-key detection is single-sourced from the zod schema: every config object is `.strict()`,
// so zod already rejects unrecognized keys. We run one structural (no-env) parse purely to harvest
// those `unrecognized_keys` issues and render them with friendly, path-aware messages. Adding a new
// config key therefore requires changing ONLY the schema — no parallel key list to keep in sync.
function findUnknownKeyDiagnostics(parsed: unknown): ConfigDiagnostic[] {
  // resolveEnvVars=false so `${VAR}` placeholders pass through untouched — this validates shape
  // without needing any secrets and never throws on a missing env var.
  const structural = withEnvVarResolution(false, () => GatewayConfig.safeParse(parsed));
  if (structural.success) return [];

  const found: Array<{ path: string[]; key: string }> = [];
  collectUnrecognizedKeys(structural.error, found);

  const seen = new Set<string>();
  const diagnostics: ConfigDiagnostic[] = [];
  for (const { path, key } of found) {
    const id = [...path, key].join('.');
    if (seen.has(id)) continue;
    seen.add(id);
    diagnostics.push({
      level: 'error',
      message: unknownKeyMessage(key, path),
      suggestion: unknownKeySuggestion(key, path),
    });
  }
  return diagnostics;
}

// Recurse into `invalid_union` errors (e.g. providers, which is a z.union): an unknown key on a
// union member is reported inside that branch's nested error, not at the top level.
function collectUnrecognizedKeys(
  error: z.ZodError,
  out: Array<{ path: string[]; key: string }>
): void {
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      const path = issue.path.map(String);
      for (const key of issue.keys) out.push({ path, key });
    } else if (issue.code === 'invalid_union') {
      for (const unionError of issue.unionErrors) collectUnrecognizedKeys(unionError, out);
    }
  }
}

function unknownKeyMessage(key: string, path: string[]): string {
  if (path[0] === 'profiles' && path.length === 2) {
    return `Unrecognized key "${key}" in profile "${path[1]}".`;
  }
  if (path[0] === 'agents' && path.length === 2) {
    return `Unrecognized key "${key}" in agent "${path[1]}".`;
  }
  return `Unknown config key "${[...path, key].join('.')}".`;
}

function unknownKeySuggestion(key: string, path: string[]): string | undefined {
  if (key === 'scope' && (path[0] === 'agents' || path[0] === 'profiles')) {
    return 'Did you mean "arg_scope"?';
  }
  if (key === 'mcps') return 'Use "providers" to declare MCP servers and builtins.';
  if (key === 'hitl')
    return 'Use "ask" for agent tool routing or "approvals" for approval providers.';
  return undefined;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (normalized === 'localhost') return true;
  const ipVersion = isIP(normalized);
  if (ipVersion === 6) return normalized === '::1';
  if (ipVersion !== 4) return false;
  const firstOctet = Number(normalized.split('.')[0]);
  return firstOctet === 127;
}

/** Check if two glob patterns could match the same tool name */
function patternsOverlap(a: string, b: string): boolean {
  // If either is a wildcard that covers the other's namespace
  const nsA = a.split('/')[0];
  const nsB = b.split('/')[0];
  if (nsA !== nsB) return false;

  // Same namespace — wildcards overlap
  if (a.endsWith('*') || b.endsWith('*')) return true;

  // Exact match
  return a === b;
}
