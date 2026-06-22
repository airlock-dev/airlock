import { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { GatewayConfig, getBuiltinProviders } from './schema.js';
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

export function loadConfig(path: string): Config {
  const raw = readFileSync(path, 'utf-8');
  const parsed: unknown = parseYaml(raw);
  const result = GatewayConfig.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid config at ${path}:\n${result.error.toString()}`);
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
  return result.data;
}

export function validateConfig(config: Config): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];
  const providerNames = new Set(Object.keys(config.providers));
  const builtins = getBuiltinProviders(config.providers);

  const profileNames = new Set(Object.keys(config.profiles));
  const sandboxPresetNames = new Set(Object.keys(config.sandbox_presets ?? {}));

  const serverHost = config.server.host;
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);
  const isLoopback = loopbackHosts.has(serverHost);
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

    const exposesGlobalSecretRoutes =
      config.server.expose_management_api || config.server.expose_hook_api;

    if (!config.server.api_secret && exposesGlobalSecretRoutes) {
      diagnostics.push({
        level: 'error',
        message:
          'server.auth_required is true, but management or hook APIs are exposed without server.api_secret.',
        suggestion:
          'Set server.api_secret, or disable expose_management_api and expose_hook_api.',
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
