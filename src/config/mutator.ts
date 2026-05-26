import { readFileSync, writeFileSync } from 'fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export type RememberAllowMode = 'always' | 'temporary';

export interface RememberAllowOptions {
  configPath: string;
  agentId: string;
  tool: string;
  mode: RememberAllowMode;
  durationMs?: number;
  now?: Date;
}

export interface RememberAllowResult {
  agentId: string;
  tool: string;
  mode: RememberAllowMode;
  expiresAt?: string;
}

interface RememberAllowRuleYaml {
  tool: string;
  expires_at?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function rememberAllowRules(value: unknown, now: Date): RememberAllowRuleYaml[] {
  if (!Array.isArray(value)) return [];
  const nowMs = now.getTime();
  return value.filter((item): item is RememberAllowRuleYaml => {
    if (!isRecord(item)) return false;
    if (typeof item.tool !== 'string') return false;
    if (item.expires_at !== undefined && typeof item.expires_at !== 'string') return false;
    return !item.expires_at || Date.parse(item.expires_at) > nowMs;
  });
}

export function rememberAllow(options: RememberAllowOptions): RememberAllowResult {
  const now = options.now ?? new Date();
  const raw = readFileSync(options.configPath, 'utf8');
  const parsed = parseYaml(raw) as unknown;
  const doc = isRecord(parsed) ? parsed : {};

  if (!isRecord(doc.agents)) {
    throw new Error('Config has no agents block to update');
  }

  const existingAgent = doc.agents[options.agentId];
  if (!isRecord(existingAgent)) {
    throw new Error(`Config has no agent "${options.agentId}" to update`);
  }

  const agent: Record<string, unknown> = { ...existingAgent };
  const activeRememberedRules = rememberAllowRules(agent.remember_allow, now).filter(
    (rule) => rule.tool !== options.tool
  );

  let expiresAt: string | undefined;
  if (options.mode === 'temporary') {
    const durationMs = options.durationMs ?? 60 * 60 * 1000;
    expiresAt = new Date(now.getTime() + durationMs).toISOString();
    agent.remember_allow = [
      ...activeRememberedRules,
      { tool: options.tool, expires_at: expiresAt },
    ];
  } else {
    const allow = stringArray(agent.allow);
    if (!allow.includes(options.tool)) {
      allow.push(options.tool);
    }
    agent.allow = allow;
    agent.ask = stringArray(agent.ask).filter((pattern) => pattern !== options.tool);
    agent.remember_allow = [...activeRememberedRules, { tool: options.tool }];
  }

  doc.agents[options.agentId] = agent;
  writeFileSync(options.configPath, stringifyYaml(doc));

  return {
    agentId: options.agentId,
    tool: options.tool,
    mode: options.mode,
    ...(expiresAt ? { expiresAt } : {}),
  };
}
