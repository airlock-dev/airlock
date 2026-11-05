import type { Decision, Profile, Resolved, Rules, Tool } from './types';

// Mirrors src/allowlist/pattern.ts and src/allowlist/engine.ts: the most specific matching pattern
// wins across tiers, and ties break deny > ask > allow. Keep these in step with the gateway.

export function specificity(pattern: string, tool: string): number {
  if (pattern === tool) return pattern.length + 1;
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -1);
    return tool.startsWith(prefix) && !tool.slice(prefix.length).includes('/') ? prefix.length : -1;
  }
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return tool.startsWith(prefix) ? prefix.length : -1;
  }
  return -1;
}

function best(patterns: string[], tool: string): { pattern: string; score: number } | null {
  let winner: { pattern: string; score: number } | null = null;
  for (const pattern of patterns) {
    const score = specificity(pattern, tool);
    if (score >= 0 && (!winner || score > winner.score)) winner = { pattern, score };
  }
  return winner;
}

export interface Resolution {
  decision: Resolved;
  pattern?: string;
}

export function resolve(rules: Pick<Rules, 'allow' | 'ask' | 'deny'>, tool: string): Resolution {
  const deny = best(rules.deny, tool);
  const ask = best(rules.ask, tool);
  const allow = best(rules.allow, tool);
  const top = Math.max(deny?.score ?? -1, ask?.score ?? -1, allow?.score ?? -1);
  if (top < 0) return { decision: 'none' };
  if (deny && deny.score === top) return { decision: 'deny', pattern: deny.pattern };
  if (ask && ask.score === top) return { decision: 'ask', pattern: ask.pattern };
  return { decision: 'allow', pattern: allow!.pattern };
}

// Union of every profile reachable through `extends`, like applyProfiles on the server.
export function inheritedRules(
  extendsIds: string[],
  profiles: Record<string, Profile>,
  seen = new Set<string>()
): Pick<Rules, 'allow' | 'ask' | 'deny'> {
  const merged = { allow: [] as string[], ask: [] as string[], deny: [] as string[] };
  for (const id of extendsIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const profile = profiles[id];
    if (!profile) continue;
    const parent = inheritedRules(profile.extends, profiles, seen);
    for (const key of ['allow', 'ask', 'deny'] as const) {
      merged[key].push(...parent[key], ...profile[key]);
    }
  }
  return merged;
}

export function effectiveRules(
  own: Rules,
  profiles: Record<string, Profile>,
  defaultProfile?: string
): Pick<Rules, 'allow' | 'ask' | 'deny'> {
  const chain =
    defaultProfile && !own.extends.includes(defaultProfile)
      ? [defaultProfile, ...own.extends]
      : own.extends;
  const inherited = inheritedRules(chain, profiles);
  return {
    allow: [...inherited.allow, ...own.allow],
    ask: [...inherited.ask, ...own.ask],
    deny: [...inherited.deny, ...own.deny],
  };
}

export interface Tally {
  allow: number;
  ask: number;
  deny: number;
  none: number;
}

export function tally(rules: Pick<Rules, 'allow' | 'ask' | 'deny'>, tools: Tool[]): Tally {
  const counts: Tally = { allow: 0, ask: 0, deny: 0, none: 0 };
  for (const tool of tools) counts[resolve(rules, tool.name).decision]++;
  return counts;
}

// Set an exact rule for one tool, or clear it so inheritance shows through.
export function setExact<T extends Pick<Rules, 'allow' | 'ask' | 'deny'>>(
  rules: T,
  tool: string,
  decision: Decision | null
): T {
  const next = {
    ...rules,
    allow: rules.allow.filter((p) => p !== tool),
    ask: rules.ask.filter((p) => p !== tool),
    deny: rules.deny.filter((p) => p !== tool),
  };
  if (decision) next[decision] = [...next[decision], tool];
  return next;
}

// Replace every rule scoped to one provider with a single wildcard (or nothing).
export function setProviderWide<T extends Pick<Rules, 'allow' | 'ask' | 'deny'>>(
  rules: T,
  provider: string,
  decision: Decision | null
): T {
  const scoped = (p: string) => p === `${provider}/*` || p.startsWith(`${provider}/`);
  const next = {
    ...rules,
    allow: rules.allow.filter((p) => !scoped(p)),
    ask: rules.ask.filter((p) => !scoped(p)),
    deny: rules.deny.filter((p) => !scoped(p)),
  };
  if (decision) next[decision] = [...next[decision], `${provider}/*`];
  return next;
}

export function applyRecommended<T extends Pick<Rules, 'allow' | 'ask' | 'deny'>>(
  rules: T,
  tools: Tool[]
): T {
  let next = rules;
  for (const tool of tools) next = setExact(next, tool.name, tool.recommended);
  return next;
}

export function groupByProvider(tools: Tool[]): [string, Tool[]][] {
  const groups = new Map<string, Tool[]>();
  for (const tool of tools) {
    const list = groups.get(tool.provider) ?? [];
    list.push(tool);
    groups.set(tool.provider, list);
  }
  return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
}

export const ID_PATTERN = /^[A-Za-z0-9_.-]+$/;

export function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}
