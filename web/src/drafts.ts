import { emptyDraft, type Draft } from './policy-editor';
import { sameList } from './policy';
import type { Agent, AgentSpec, Profile, Rules } from './types';

export function draftFromAgent(agent: Agent): Draft {
  return {
    extends: [...agent.extends],
    allow: [...agent.allow],
    ask: [...agent.ask],
    deny: [...agent.deny],
    inheritDefault: agent.inheritDefault,
    approvalMode: agent.approvalMode ?? null,
    exec: { allow: [...agent.exec.allow], ask: [...agent.exec.ask], deny: [...agent.exec.deny] },
    http: { domainAllowlist: [...agent.http.domainAllowlist] },
  };
}

export function draftFromProfile(profile: Profile): Draft {
  return {
    ...emptyDraft(),
    extends: [...profile.extends],
    allow: [...profile.allow],
    ask: [...profile.ask],
    deny: [...profile.deny],
  };
}

// Full spec for a new agent, leaving out empty sections so the YAML stays tidy.
export function createAgentSpec(draft: Draft): AgentSpec {
  const spec: AgentSpec =
    nonEmpty({
      extends: draft.extends,
      allow: draft.allow,
      ask: draft.ask,
      deny: draft.deny,
    }) ?? {};
  if (!draft.inheritDefault) spec.inherit_default = false;
  if (draft.approvalMode) spec.approval_mode = draft.approvalMode;
  const exec = nonEmpty({ allow: draft.exec.allow, ask: draft.exec.ask, deny: draft.exec.deny });
  if (exec) spec.exec = exec;
  if (draft.http.domainAllowlist.length)
    spec.http = { domain_allowlist: draft.http.domainAllowlist };
  return spec;
}

// Only the fields that changed, so an update never rewrites what the operator did not touch.
export function updateAgentSpec(before: Draft, after: Draft): AgentSpec {
  const spec: AgentSpec = {};
  for (const key of ['extends', 'allow', 'ask', 'deny'] as const) {
    if (!sameList(before[key], after[key])) spec[key] = after[key];
  }
  if (before.inheritDefault !== after.inheritDefault) spec.inherit_default = after.inheritDefault;
  if (before.approvalMode !== after.approvalMode) spec.approval_mode = after.approvalMode;
  const exec: NonNullable<AgentSpec['exec']> = {};
  for (const key of ['allow', 'ask', 'deny'] as const) {
    if (!sameList(before.exec[key], after.exec[key])) exec[key] = after.exec[key];
  }
  if (Object.keys(exec).length) spec.exec = exec;
  if (!sameList(before.http.domainAllowlist, after.http.domainAllowlist)) {
    spec.http = { domain_allowlist: after.http.domainAllowlist };
  }
  return spec;
}

export function profileSpec(draft: Draft): Partial<Rules> {
  return (
    nonEmpty({ extends: draft.extends, allow: draft.allow, ask: draft.ask, deny: draft.deny }) ?? {}
  );
}

export function updateProfileSpec(before: Draft, after: Draft): Partial<Rules> {
  const spec: Partial<Rules> = {};
  for (const key of ['extends', 'allow', 'ask', 'deny'] as const) {
    if (!sameList(before[key], after[key])) spec[key] = after[key];
  }
  return spec;
}

function nonEmpty<T extends Record<string, string[]>>(value: T): Partial<T> | undefined {
  const entries = Object.entries(value).filter(([, list]) => list.length > 0);
  return entries.length ? (Object.fromEntries(entries) as Partial<T>) : undefined;
}
