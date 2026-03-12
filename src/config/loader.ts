import { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { GatewayConfig, getBuiltinProviders, getMcpConfigs } from './schema.js';
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
  const parsed = parseYaml(raw);
  const result = GatewayConfig.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid config at ${path}:\n${result.error.toString()}`);
  }
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
  const errors = diagnostics.filter(d => d.level === 'error');
  if (errors.length > 0) {
    throw new Error(
      `Config validation failed with ${errors.length} error(s):\n` +
      errors.map(e => `  - ${e.agent ? `[${e.agent}] ` : ''}${e.message}`).join('\n'),
    );
  }
  return result.data;
}

export function validateConfig(config: Config): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];
  const providerNames = new Set(Object.keys(config.providers));
  const builtins = getBuiltinProviders(config.providers);
  const mcpNames = new Set(Object.keys(getMcpConfigs(config.providers)));

  for (const [agentId, agent] of Object.entries(config.agents)) {
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
        if (matches(denyPattern, allowPattern) || matches(allowPattern, denyPattern) ||
            patternsOverlap(allowPattern, denyPattern)) {
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
        if (matches(denyPattern, askPattern) || matches(askPattern, denyPattern) ||
            patternsOverlap(askPattern, denyPattern)) {
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
    const hasCatchAllDeny = agent.exec.deny.some(p => p === '*');
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
