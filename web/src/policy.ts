import type { Decision, Profile, Resolved, Rules, Tool } from './types';

// Mirrors src/allowlist/pattern.ts and src/allowlist/engine.ts: the most specific matching pattern
// wins across tiers, and ties break deny > ask > allow. Keep these in step with the gateway.

const DECISION_PRIORITY: Record<Decision, number> = { deny: 3, ask: 2, allow: 1 };

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

export interface RuleMatch {
  decision: Decision;
  pattern: string;
  score: number;
  exact: boolean;
  source: string;
  isWinner: boolean;
}

export interface ResolutionExplanation {
  tool: string;
  decision: Resolved;
  winner?: RuleMatch;
  matches: RuleMatch[];
  reason: string;
}

function collectInheritedMatches(
  extendsIds: string[],
  profiles: Record<string, Profile>,
  tool: string,
  out: Omit<RuleMatch, 'isWinner'>[],
  seen = new Set<string>(),
  defaultProfile?: string
): void {
  for (const id of extendsIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const profile = profiles[id];
    if (!profile) continue;
    collectInheritedMatches(profile.extends, profiles, tool, out, seen, defaultProfile);
    const label = id === defaultProfile ? `default profile "${id}"` : `profile "${id}"`;
    for (const decision of ['deny', 'ask', 'allow'] as const) {
      for (const pattern of profile[decision]) {
        const score = specificity(pattern, tool);
        if (score >= 0) {
          out.push({
            decision,
            pattern,
            score,
            exact: pattern === tool,
            source: label,
          });
        }
      }
    }
  }
}

/**
 * Explain exactly which rule wins for `tool` and why, including profile inheritance and tie-breaks.
 */
export function explainResolution(
  own: Rules,
  profiles: Record<string, Profile>,
  tool: string,
  defaultProfile?: string,
  ownLabel = 'own rules'
): ResolutionExplanation {
  const trimmed = tool.trim();
  if (!trimmed) {
    return { tool: '', decision: 'none', matches: [], reason: 'Enter a tool name to test access.' };
  }

  const raw: Omit<RuleMatch, 'isWinner'>[] = [];
  const chain =
    defaultProfile && !own.extends.includes(defaultProfile)
      ? [defaultProfile, ...own.extends]
      : own.extends;
  collectInheritedMatches(chain, profiles, trimmed, raw, new Set(), defaultProfile);

  for (const decision of ['deny', 'ask', 'allow'] as const) {
    for (const pattern of own[decision]) {
      const score = specificity(pattern, trimmed);
      if (score >= 0) {
        raw.push({
          decision,
          pattern,
          score,
          exact: pattern === trimmed,
          source: ownLabel,
        });
      }
    }
  }

  if (raw.length === 0) {
    return {
      tool: trimmed,
      decision: 'none',
      matches: [],
      reason: 'No allow, ask, or deny rule matched — Airlock blocks unmatched tools by default.',
    };
  }

  // Deduplicate identical (decision, pattern, source) rows, then rank by specificity desc, then
  // deny > ask > allow, preferring own rules over inherited on exact identical ties.
  const deduped: Omit<RuleMatch, 'isWinner'>[] = [];
  const keys = new Set<string>();
  for (const item of raw) {
    const key = `${item.decision}\0${item.pattern}\0${item.source}`;
    if (keys.has(key)) continue;
    keys.add(key);
    deduped.push(item);
  }

  deduped.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (DECISION_PRIORITY[b.decision] !== DECISION_PRIORITY[a.decision]) {
      return DECISION_PRIORITY[b.decision] - DECISION_PRIORITY[a.decision];
    }
    if (a.source === ownLabel && b.source !== ownLabel) return -1;
    if (b.source === ownLabel && a.source !== ownLabel) return 1;
    return a.source.localeCompare(b.source);
  });

  const matches: RuleMatch[] = deduped.map((item, idx) => ({ ...item, isWinner: idx === 0 }));
  const winner = matches[0];
  const sameScoreDifferentDecision = matches.filter(
    (m) => m.score === winner.score && m.decision !== winner.decision
  );

  const matchKind = winner.exact ? 'exact match' : `wildcard (specificity ${winner.score})`;
  let reason = `${winner.decision.toUpperCase()} via "${winner.pattern}" (${matchKind}) from ${winner.source}.`;
  if (sameScoreDifferentDecision.length > 0) {
    const beaten = Array.from(new Set(sameScoreDifferentDecision.map((m) => m.decision))).join(
      ', '
    );
    reason += ` Tied specificity broke by precedence (deny > ask > allow) over ${beaten}.`;
  }

  return {
    tool: trimmed,
    decision: winner.decision,
    winner,
    matches,
    reason,
  };
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
