import { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { GatewayConfig, getBuiltinProviders } from './schema.js';
import { applyProfiles } from './profiles.js';
import { matches } from '../allowlist/pattern.js';
import { childLogger } from '../util/logger.js';
import type { z } from 'zod';
import type { AgentConfig, ToolArgConstraintConfig, ValueSetConfig } from './schema.js';

const log = childLogger('config');

export type Config = z.infer<typeof GatewayConfig>;

export interface ConfigDiagnostic {
  level: 'error' | 'warn' | 'info';
  agent?: string;
  message: string;
  suggestion?: string;
}

export function loadConfig(path: string): Config {
  const raw = readFileSync(path, 'utf-8');
  const parsed: unknown = parseYaml(raw);
  const result = GatewayConfig.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid config at ${path}:\n${formatZodError(result.error)}`);
  }
  applyProfiles(result.data);
  const diagnostics = validateConfig(result.data);
  for (const d of diagnostics) {
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
  const errors = diagnostics.filter((d) => d.level === 'error');
  if (errors.length > 0) {
    throw new Error(
      `Config validation failed with ${errors.length} error(s):\n` +
        errors.map((e) => `  - ${e.agent ? `[${e.agent}] ` : ''}${e.message}`).join('\n')
    );
  }
  normalizeConfig(result.data);
  return result.data;
}

export function validateConfig(config: Config): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];
  const providerNames = new Set(Object.keys(config.providers));
  const builtins = getBuiltinProviders(config.providers);

  const profileNames = new Set(Object.keys(config.profiles));
  const sandboxPresetNames = new Set(Object.keys(config.sandbox_presets ?? {}));
  const valueSetNames = new Set(Object.keys(config.value_sets ?? {}));
  const argDimensionNames = new Set(Object.keys(config.arg_dimensions ?? {}));
  const scopedDimensions = new Set<string>();

  const serverHost = config.server.host;
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);
  const isLoopback = loopbackHosts.has(serverHost);
  const exposesNonMcpRoutes =
    config.server.expose_management_api ||
    config.server.expose_tools_api ||
    config.server.expose_hook_api;
  const agentsWithoutTokens = Object.entries(config.agents)
    .filter(([, agent]) => !agent.token)
    .map(([agentId]) => agentId);
  const requireAgentTokens = config.server.require_agent_tokens || !isLoopback;

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
      suggestion: `Add token to agents: ${agentsWithoutTokens.join(', ')}. For reverse-proxy exposure on loopback, set server.require_agent_tokens: true to keep this check enabled.`,
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

    if (!config.server.api_secret && exposesNonMcpRoutes) {
      diagnostics.push({
        level: 'error',
        message:
          'server.auth_required is true, but non-MCP APIs are exposed without server.api_secret.',
        suggestion:
          'Set server.api_secret, or disable expose_management_api, expose_tools_api, and expose_hook_api.',
      });
    }
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
    const knownNamespaces = new Set(providerNames);

    for (const pattern of allPatterns) {
      const ns = pattern.split('/')[0];
      if (ns) referencedNamespaces.add(ns);
    }

    for (const aliasName of Object.keys(agent.tool_overrides)) {
      const ns = aliasName.split('/')[0];
      if (ns) knownNamespaces.add(ns);
    }

    // Check for unknown providers
    for (const ns of referencedNamespaces) {
      if (!knownNamespaces.has(ns)) {
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
    if (agent.allow.length === 0 && agent.ask.length === 0) {
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

    collectArgPolicyDiagnostics(diagnostics, agentId, agent.arg_policy, valueSetNames);

    if (agent.arg_scope) {
      for (const [dimensionName, constraint] of Object.entries(agent.arg_scope)) {
        scopedDimensions.add(dimensionName);
        if (!argDimensionNames.has(dimensionName)) {
          diagnostics.push({
            level: 'error',
            agent: agentId,
            message: `arg_scope references unknown arg_dimension "${dimensionName}".`,
            suggestion: `Add "${dimensionName}" to the top-level arg_dimensions block, or check for typos.`,
          });
        }
        collectConstraintReferenceDiagnostics(
          diagnostics,
          agentId,
          `arg_scope.${dimensionName}`,
          constraint,
          valueSetNames
        );
      }
    }

    const declaredArgControls = agent.arg_policy !== undefined || agent.arg_scope !== undefined;
    if (declaredArgControls && effectiveAgentConstraintCount(agent, config) === 0) {
      diagnostics.push({
        level: 'error',
        agent: agentId,
        message:
          'Declared arg_scope or arg_policy resolves to zero effective argument constraints.',
        suggestion:
          'Check arg_dimensions bindings, arg_scope dimension names, and arg_policy entries so the restriction applies to at least one tool argument.',
      });
    }
  }

  for (const [dimensionName, dimension] of Object.entries(config.arg_dimensions ?? {})) {
    const bindingCount = Object.values(dimension.bindings).reduce(
      (count, args) => count + args.length,
      0
    );
    if (bindingCount === 0) {
      diagnostics.push({
        level: 'warn',
        message: `arg_dimensions.${dimensionName}.bindings is empty; scopes using it will not constrain any tool arguments.`,
      });
    }

    if (!scopedDimensions.has(dimensionName)) {
      diagnostics.push({
        level: 'warn',
        message: `arg_dimensions.${dimensionName} is not used by any agent arg_scope.`,
        suggestion: `Remove "${dimensionName}" or reference it from an agent/profile arg_scope.`,
      });
    }
  }

  collectValueSetFootgunDiagnostics(diagnostics, config);

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

function normalizeConfig(config: Config): void {
  coerceStringMatcherValues(config);
  desugarArgScopes(config);
  desugarArgPolicyRefs(config);
}

function collectArgPolicyDiagnostics(
  diagnostics: ConfigDiagnostic[],
  agentId: string,
  policy: AgentConfig['arg_policy'],
  valueSetNames: Set<string>
): void {
  for (const [toolName, constraints] of Object.entries(policy ?? {})) {
    for (const [argName, constraint] of Object.entries(constraints)) {
      collectConstraintReferenceDiagnostics(
        diagnostics,
        agentId,
        `arg_policy.${toolName}.${argName}`,
        constraint,
        valueSetNames
      );
    }
  }
}

function collectConstraintReferenceDiagnostics(
  diagnostics: ConfigDiagnostic[],
  agentId: string,
  path: string,
  constraint: ToolArgConstraintConfig,
  valueSetNames: Set<string>
): void {
  for (const key of ['in', 'glob_in', 'each_in'] as const) {
    const valueSetName = constraint[key];
    if (valueSetName && !valueSetNames.has(valueSetName)) {
      diagnostics.push({
        level: 'error',
        agent: agentId,
        message: `${path}.${key} references unknown value_set "${valueSetName}".`,
        suggestion: `Add "${valueSetName}" to the top-level value_sets block, or check for typos.`,
      });
    }
  }
}

function effectiveConstraintCount(
  policy: AgentConfig['arg_policy'] | AgentConfig['arg_scope']
): number {
  let count = 0;
  const entries = Object.values(policy ?? {}) as Array<
    ToolArgConstraintConfig | Record<string, ToolArgConstraintConfig>
  >;
  for (const constraints of entries) {
    count += isArgConstraint(constraints) ? 1 : Object.keys(constraints).length;
  }
  return count;
}

function effectiveAgentConstraintCount(agent: AgentConfig, config: Config): number {
  let count = effectiveConstraintCount(agent.arg_policy);

  for (const dimensionName of Object.keys(agent.arg_scope ?? {})) {
    const dimension = config.arg_dimensions[dimensionName];
    if (!dimension) continue;
    count += Object.values(dimension.bindings).reduce((sum, args) => sum + args.length, 0);
  }

  return count;
}

function isArgConstraint(value: unknown): value is ToolArgConstraintConfig {
  return (
    !!value &&
    typeof value === 'object' &&
    ['equals', 'allow', 'in', 'glob_allow', 'glob_in', 'each_allow', 'each_in'].some((key) =>
      Object.prototype.hasOwnProperty.call(value, key)
    )
  );
}

function collectValueSetFootgunDiagnostics(diagnostics: ConfigDiagnostic[], config: Config): void {
  for (const [name, valueSet] of Object.entries(config.value_sets ?? {})) {
    for (const value of valueSetValues(valueSet)) {
      if (isYamlStringFootgun(value)) {
        diagnostics.push({
          level: 'warn',
          message: `value_sets.${name} contains value ${String(value)} that looks like an unquoted string; quote it (${quoteSuggestion(value)}).`,
        });
      }
    }
  }

  for (const [agentId, agent] of Object.entries(config.agents)) {
    forEachConstraint(agent, (path, constraint) => {
      for (const key of ['allow', 'glob_allow', 'each_allow'] as const) {
        for (const value of constraint[key] ?? []) {
          if (isYamlStringFootgun(value)) {
            diagnostics.push({
              level: 'warn',
              agent: agentId,
              message: `${path}.${key} contains value ${String(value)} that looks like an unquoted string; quote it (${quoteSuggestion(value)}).`,
            });
          }
        }
      }
    });
  }
}

function forEachConstraint(
  agent: AgentConfig,
  visit: (path: string, constraint: ToolArgConstraintConfig) => void
): void {
  for (const [toolName, constraints] of Object.entries(agent.arg_policy ?? {})) {
    for (const [argName, constraint] of Object.entries(constraints)) {
      visit(`arg_policy.${toolName}.${argName}`, constraint);
    }
  }

  for (const [dimensionName, constraint] of Object.entries(agent.arg_scope ?? {})) {
    visit(`arg_scope.${dimensionName}`, constraint);
  }
}

function isYamlStringFootgun(value: unknown): value is number | boolean {
  return typeof value === 'number' || typeof value === 'boolean';
}

function quoteSuggestion(value: number | boolean): string {
  const text = String(value);
  const quoted = typeof value === 'number' && /^1\d{10,14}$/.test(text) ? `+${text}` : text;
  return `"${quoted}"`;
}

function coerceStringMatcherValues(config: Config): void {
  for (const [name, valueSet] of Object.entries(config.value_sets ?? {})) {
    const values = valueSetValues(valueSet).map(coerceScalarStringFootgun);
    config.value_sets[name] = Array.isArray(valueSet) ? values : { values };
  }

  for (const agent of Object.values(config.agents)) {
    forEachConstraint(agent, (_path, constraint) => {
      if (constraint.allow) constraint.allow = constraint.allow.map(coerceScalarStringFootgun);
      if (constraint.glob_allow) {
        constraint.glob_allow = constraint.glob_allow.map(coerceScalarStringFootgun);
      }
      if (constraint.each_allow) {
        constraint.each_allow = constraint.each_allow.map(coerceScalarStringFootgun);
      }
    });
  }
}

function coerceScalarStringFootgun(value: unknown): unknown {
  return isYamlStringFootgun(value) ? String(value) : value;
}

function desugarArgScopes(config: Config): void {
  for (const agent of Object.values(config.agents)) {
    if (!agent.arg_scope) continue;
    const scopedPolicy: NonNullable<AgentConfig['arg_policy']> = {};

    for (const [dimensionName, constraint] of Object.entries(agent.arg_scope)) {
      const dimension = config.arg_dimensions[dimensionName];
      if (!dimension) continue;

      for (const [toolName, argNames] of Object.entries(dimension.bindings)) {
        scopedPolicy[toolName] ??= {};
        for (const argName of argNames) {
          scopedPolicy[toolName][argName] = { ...constraint };
        }
      }
    }

    agent.arg_policy = mergeArgPolicies(scopedPolicy, agent.arg_policy);
  }
}

function desugarArgPolicyRefs(config: Config): void {
  for (const agent of Object.values(config.agents)) {
    forEachConstraint(agent, (_path, constraint) => {
      if (constraint.in) {
        constraint.allow = [
          ...(constraint.allow ?? []),
          ...valueSetValues(config.value_sets[constraint.in]),
        ];
        delete constraint.in;
      }
      if (constraint.glob_in) {
        constraint.glob_allow = [
          ...(constraint.glob_allow ?? []),
          ...valueSetValues(config.value_sets[constraint.glob_in]),
        ];
        delete constraint.glob_in;
      }
      if (constraint.each_in) {
        constraint.each_allow = [
          ...(constraint.each_allow ?? []),
          ...valueSetValues(config.value_sets[constraint.each_in]),
        ];
        delete constraint.each_in;
      }
    });
  }
}

function mergeArgPolicies(
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

function valueSetValues(valueSet: ValueSetConfig | undefined): unknown[] {
  if (!valueSet) return [];
  return Array.isArray(valueSet) ? valueSet : valueSet.values;
}

function formatZodError(error: z.ZodError): string {
  return error.issues.map(formatZodIssue).join('\n');
}

function formatZodIssue(issue: z.ZodIssue): string {
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((key) => formatUnrecognizedKey(issue.path, key)).join('\n');
  }

  const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${path}${issue.message}`;
}

function formatUnrecognizedKey(path: (string | number)[], key: string): string {
  const context = describeConfigPath(path);
  const suggestion = suggestKey(key, knownKeysForPath(path));
  const hint = suggestion ? ` (did you mean "${suggestion}"?)` : '';
  return `Unrecognized key "${key}"${context ? ` in ${context}` : ''}${hint}.`;
}

function describeConfigPath(path: (string | number)[]): string {
  if (path[0] === 'profiles' && typeof path[1] === 'string') return `profile "${path[1]}"`;
  if (path[0] === 'agents' && typeof path[1] === 'string') return `agent "${path[1]}"`;
  if (path.length === 0) return 'top-level config';
  return path.join('.');
}

function knownKeysForPath(path: (string | number)[]): string[] {
  if (path.length === 0) {
    return [
      'providers',
      'profiles',
      'value_sets',
      'arg_dimensions',
      'sandbox_presets',
      'clis',
      'apis',
      'agents',
      'approvals',
      'security',
      'audit',
      'server',
    ];
  }
  if (path[0] === 'profiles') return ['extends', 'allow', 'ask', 'deny', 'arg_policy', 'arg_scope'];
  if (path[0] === 'agents') {
    return [
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
    ];
  }
  return [];
}

function suggestKey(key: string, candidates: string[]): string | undefined {
  if (key === 'scope' && candidates.includes('arg_scope')) return 'arg_scope';

  let best: { candidate: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = levenshtein(key, candidate);
    if (!best || distance < best.distance) best = { candidate, distance };
  }
  return best && best.distance <= Math.max(2, Math.floor(best.candidate.length / 3))
    ? best.candidate
    : undefined;
}

function levenshtein(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) rows[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }

  return rows[a.length][b.length];
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
