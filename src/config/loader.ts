import { readFileSync } from 'fs';
import { isIP } from 'net';
import { parse as parseYaml } from 'yaml';
import { GatewayConfig, getBuiltinProviders, withEnvVarResolution } from './schema.js';
import { applyProfiles } from './profiles.js';
import { matches } from '../allowlist/pattern.js';
import { childLogger } from '../util/logger.js';
import type { z } from 'zod';

const log = childLogger('config');

export type Config = z.infer<typeof GatewayConfig>;

export interface ConfigDiagnostic {
  level: 'error' | 'warn' | 'info';
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

  const diagnostics = options.strict ? findUnknownKeys(parsed) : [];
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

    if (!config.server.api_secret && managementApiEnabled) {
      diagnostics.push({
        level: 'error',
        message:
          'server.auth_required is true, but the control-plane management API is enabled without server.api_secret.',
        suggestion: 'Set server.api_secret, or disable server.management_api.enabled.',
      });
    }
  }

  if (managementApiEnabled && !config.server.api_secret) {
    diagnostics.push({
      level: 'error',
      message: 'server.management_api.enabled requires server.api_secret.',
      suggestion: 'Set server.api_secret so control-plane requests require bearer-token auth.',
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

  for (const [agentId, agent] of Object.entries(config.agents)) {
    // Check for unknown profile references
    for (const ref of agent.extends) {
      if (!profileNames.has(ref)) {
        diagnostics.push({
          level: 'error',
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

    for (const pattern of allPatterns) {
      const ns = pattern.split('/')[0];
      if (ns) referencedNamespaces.add(ns);
    }

    // Check for unknown providers
    for (const ns of referencedNamespaces) {
      if (!providerNames.has(ns)) {
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

function findUnknownKeys(value: unknown): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];
  checkObjectKeys(diagnostics, value, [], rootKeys);
  return diagnostics;
}

const rootKeys = new Set([
  'providers',
  'value_sets',
  'arg_dimensions',
  'profiles',
  'sandbox_presets',
  'clis',
  'apis',
  'agents',
  'approvals',
  'security',
  'audit',
  'server',
]);
const providerKeys = new Set([
  'type',
  'enabled',
  'command',
  'args',
  'env',
  'url',
  'headers',
  'oauth',
  'oauth_callback_port',
  'oauth_callback_url',
  'client_id',
  'client_secret',
]);
const agentKeys = new Set([
  'token',
  'extends',
  'allow',
  'remember_allow',
  'ask',
  'deny',
  'tool_overrides',
  'arg_policy',
  'arg_scope',
  'exec',
  'http',
  'sandbox',
  'middleware',
]);
const profileKeys = new Set(['extends', 'allow', 'ask', 'deny', 'arg_policy', 'arg_scope']);
const serverKeys = new Set([
  'port',
  'host',
  'api_secret',
  'auth_required',
  'require_agent_tokens',
  'allowed_origins',
  'expose_tools_api',
  'management_api',
  'expose_management_api',
  'expose_hook_api',
]);
const managementApiKeys = new Set([
  'enabled',
  'host',
  'port',
  'insecure_remote_bind',
  'expose_hook_api',
]);
const argDimensionKeys = new Set(['match', 'normalize', 'bindings']);

function checkObjectKeys(
  diagnostics: ConfigDiagnostic[],
  value: unknown,
  path: string[],
  allowed: Set<string>
): void {
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      const fullPath = [...path, key].join('.');
      diagnostics.push({
        level: 'error',
        message: `Unknown config key "${fullPath}".`,
        suggestion: unknownKeySuggestion(key, path),
      });
    }
  }

  if (path.length === 0) {
    checkRecordChildren(diagnostics, value.providers, ['providers'], providerKeys);
    checkRecordChildren(diagnostics, value.agents, ['agents'], agentKeys);
    checkRecordChildren(diagnostics, value.profiles, ['profiles'], profileKeys);
    checkRecordChildren(diagnostics, value.arg_dimensions, ['arg_dimensions'], argDimensionKeys);
    checkObjectKeys(diagnostics, value.server, ['server'], serverKeys);
  } else if (path.join('.') === 'server') {
    checkObjectKeys(
      diagnostics,
      value.management_api,
      ['server', 'management_api'],
      managementApiKeys
    );
  }
}

function checkRecordChildren(
  diagnostics: ConfigDiagnostic[],
  value: unknown,
  path: string[],
  allowed: Set<string>
): void {
  if (!isRecord(value)) return;
  for (const [name, child] of Object.entries(value)) {
    if (isRecord(child)) {
      checkObjectKeys(diagnostics, child, [...path, name], allowed);
    }
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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
