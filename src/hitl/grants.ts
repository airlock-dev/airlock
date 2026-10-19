import { createHash } from 'crypto';
import type { ApprovalGrantEntry } from '../audit/db.js';
import { generateId } from '../util/id.js';
import { childLogger } from '../util/logger.js';

const log = childLogger('hitl-grants');

/**
 * Safety tier of a tool, derived from MCP tool annotations (or a `tool_overrides.<tool>.tier`
 * override). Ordered: a grant for a tier also covers every tier below it.
 *
 * Follows the MCP spec defaults: a tool is only `read` when it says `readOnlyHint: true`, and only
 * `write` (non-destructive) when it says `destructiveHint: false`. Everything else is treated as
 * `destructive`, so an unannotated tool never sneaks into a "read-only tools" grant.
 */
export type ToolTier = 'read' | 'write' | 'destructive';

const TIER_RANK: Record<ToolTier, number> = { read: 0, write: 1, destructive: 2 };

export function tierFromAnnotations(
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean } | undefined
): ToolTier {
  if (annotations?.readOnlyHint === true) return 'read';
  if (annotations?.destructiveHint === false) return 'write';
  return 'destructive';
}

export function tierCovers(grantTier: ToolTier, toolTier: ToolTier): boolean {
  return TIER_RANK[toolTier] <= TIER_RANK[grantTier];
}

/** What a grant covers. */
export type GrantScope =
  /** One exact call: tool + canonical args fingerprint. Created by plans and async approvals. */
  | { kind: 'call'; tool: string; fingerprint: string }
  /** Any call to one tool. */
  | { kind: 'tool'; tool: string }
  /** Any tool at or below a safety tier, optionally limited to one provider. */
  | { kind: 'tier'; tier: Exclude<ToolTier, 'destructive'>; provider?: string }
  /** Any tool from one provider. */
  | { kind: 'provider'; provider: string }
  /** Any tool a named profile lists under allow/ask. */
  | { kind: 'profile'; profile: string };

export type GrantSource = 'approval' | 'operator' | 'plan' | 'async';

export interface Grant {
  id: string;
  agentId: string;
  /** When set, the grant only applies to calls from this MCP session. */
  sessionId?: string;
  scope: GrantScope;
  source: GrantSource;
  /** The approval request that created this grant, if any. */
  approvalId?: string;
  /** Short human description, e.g. "gmail/read_email for 15m". */
  label?: string;
  createdAt: string;
  expiresAt?: string;
  /** Remaining uses; undefined = unlimited until expiry. */
  usesRemaining?: number;
}

/** Everything the gate knows about a call that needs approval. */
export interface ApprovalSubject {
  agentId: string;
  tool: string;
  fingerprint: string;
  provider: string;
  tier: ToolTier;
  sessionId?: string;
  /**
   * True when something other than the allowlist demanded approval (a detector, command policy,
   * exec policy). Broad grants never cover escalated calls; only an exact `call` grant does,
   * because the operator saw those exact arguments.
   */
  escalated: boolean;
}

/** An operator's request to turn an approval into a grant. */
export interface GrantSpec {
  scope: 'tool' | 'tier' | 'provider' | 'profile';
  /** For scope=tier: which tier to cover (default: the request's own tier, capped at write). */
  tier?: 'read' | 'write';
  /** For scope=tier: limit to the request's provider (default true). */
  sameProvider?: boolean;
  /** For scope=profile: the profile name. */
  profile?: string;
  durationMs?: number;
  maxUses?: number;
  /** Bind the grant to the requesting MCP session only. */
  sessionOnly?: boolean;
}

/** A grant option an approval UI can offer for a given request. */
export interface GrantOption {
  scope: GrantSpec['scope'];
  label: string;
  tier?: 'read' | 'write';
  profile?: string;
}

export interface GrantPersistence {
  insertGrant?(entry: ApprovalGrantEntry): void;
  updateGrantUses?(id: string, usesRemaining: number): void;
  consumeGrantUse?(id: string): boolean;
  getGrantById?(id: string): ApprovalGrantEntry | undefined;
  revokeGrant?(id: string): void;
  getActiveGrants?(): ApprovalGrantEntry[];
}

export interface GrantStoreOptions {
  /** Whether a named profile lists the tool under allow/ask (and doesn't deny it). */
  profileCovers?: (profile: string, tool: string) => boolean;
  now?: () => number;
}

/** Stable JSON: object keys sorted recursively so equal args always hash equal. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function fingerprintCall(tool: string, args: Record<string, unknown>): string {
  return createHash('sha256').update(tool).update('\0').update(canonicalJson(args)).digest('hex');
}

export function providerOf(tool: string): string {
  const i = tool.indexOf('/');
  return i > 0 ? tool.slice(0, i) : tool;
}

/** Most specific scope first: an exact call grant is consumed before a broad one. */
const SCOPE_PRIORITY: Record<GrantScope['kind'], number> = {
  call: 0,
  tool: 1,
  tier: 2,
  provider: 3,
  profile: 4,
};

export class GrantStore {
  private grants = new Map<string, Grant>();
  private now: () => number;

  constructor(
    private persistence: GrantPersistence | undefined,
    private options: GrantStoreOptions = {}
  ) {
    this.now = options.now ?? Date.now;
  }

  setProfileResolver(profileCovers: (profile: string, tool: string) => boolean): void {
    this.options.profileCovers = profileCovers;
  }

  /** Load still-active grants persisted by a previous run (or by another process). */
  load(): void {
    const rows = this.persistence?.getActiveGrants?.() ?? [];
    for (const row of rows) {
      if (this.grants.has(row.id)) continue;
      try {
        const scope = JSON.parse(row.scope) as GrantScope;
        this.grants.set(row.id, {
          id: row.id,
          agentId: row.agent_id,
          ...(row.session_id ? { sessionId: row.session_id } : {}),
          scope,
          source: row.source as GrantSource,
          ...(row.approval_id ? { approvalId: row.approval_id } : {}),
          ...(row.label ? { label: row.label } : {}),
          createdAt: row.created_at,
          ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
          ...(row.uses_remaining !== null ? { usesRemaining: row.uses_remaining } : {}),
        });
      } catch (err) {
        log.warn({ err, id: row.id }, 'Skipping unreadable persisted grant');
      }
    }
    if (rows.length > 0) log.info({ count: this.grants.size }, 'Loaded active approval grants');
  }

  create(input: Omit<Grant, 'id' | 'createdAt'>): Grant {
    const grant: Grant = {
      ...input,
      id: generateId(),
      createdAt: new Date(this.now()).toISOString(),
    };
    this.grants.set(grant.id, grant);
    this.persistence?.insertGrant?.({
      id: grant.id,
      agent_id: grant.agentId,
      session_id: grant.sessionId ?? null,
      scope: JSON.stringify(grant.scope),
      source: grant.source,
      approval_id: grant.approvalId ?? null,
      label: grant.label ?? null,
      created_at: grant.createdAt,
      expires_at: grant.expiresAt ?? null,
      uses_remaining: grant.usesRemaining ?? null,
      revoked_at: null,
    });
    log.info(
      { id: grant.id, agentId: grant.agentId, scope: grant.scope, expiresAt: grant.expiresAt },
      'Approval grant created'
    );
    return grant;
  }

  revoke(id: string): boolean {
    const local = this.grants.delete(id);
    // A grant created by another process sharing the database is revocable here too.
    const row = local ? undefined : this.persistence?.getGrantById?.(id);
    if (!local && (!row || row.revoked_at)) return false;
    this.persistence?.revokeGrant?.(id);
    log.info({ id }, 'Approval grant revoked');
    return true;
  }

  get(id: string): Grant | undefined {
    const grant = this.grants.get(id);
    return grant && this.isActive(grant) ? grant : undefined;
  }

  list(agentId?: string): Grant[] {
    this.prune();
    return [...this.grants.values()].filter((g) => !agentId || g.agentId === agentId);
  }

  /** Find the best grant covering a subject without consuming it. */
  find(subject: ApprovalSubject, onlyIds?: Set<string>): Grant | undefined {
    this.prune();
    let best: Grant | undefined;
    for (const grant of this.grants.values()) {
      if (onlyIds && !onlyIds.has(grant.id)) continue;
      if (!this.covers(grant, subject)) continue;
      if (!best || SCOPE_PRIORITY[grant.scope.kind] < SCOPE_PRIORITY[best.scope.kind]) best = grant;
    }
    return best;
  }

  /**
   * Find and consume one use of the best grant covering a subject.
   *
   * With a database, the database is the source of truth: several processes (stdio mode runs one
   * per session) can share it, so a use is spent with an atomic conditional UPDATE and a revoke made
   * elsewhere is honoured. Grants created by another process are picked up on a miss.
   */
  consume(subject: ApprovalSubject, onlyIds?: Set<string>): Grant | undefined {
    for (let attempt = 0; attempt < 2; attempt++) {
      let grant = this.find(subject, onlyIds);
      while (grant) {
        if (this.spendUse(grant)) return grant;
        grant = this.find(subject, onlyIds);
      }
      if (attempt === 0 && !onlyIds && this.persistence?.getActiveGrants) this.load();
      else break;
    }
    return undefined;
  }

  /** Spend one use; false (and the grant is dropped locally) if it is used up or revoked. */
  private spendUse(grant: Grant): boolean {
    const shared =
      typeof this.persistence?.consumeGrantUse === 'function' &&
      typeof this.persistence.getGrantById === 'function';
    if (grant.usesRemaining === undefined) {
      if (shared) {
        const row = this.persistence!.getGrantById!(grant.id);
        if (row?.revoked_at) {
          this.grants.delete(grant.id);
          return false;
        }
      }
      return true;
    }
    if (shared) {
      if (!this.persistence!.consumeGrantUse!(grant.id)) {
        this.grants.delete(grant.id);
        return false;
      }
      grant.usesRemaining = this.persistence!.getGrantById!(grant.id)?.uses_remaining ?? 0;
    } else {
      grant.usesRemaining -= 1;
      this.persistence?.updateGrantUses?.(grant.id, grant.usesRemaining);
    }
    if (grant.usesRemaining <= 0) this.grants.delete(grant.id);
    return true;
  }

  covers(grant: Grant, subject: ApprovalSubject): boolean {
    if (!this.isActive(grant)) return false;
    if (grant.agentId !== subject.agentId) return false;
    if (grant.sessionId && grant.sessionId !== subject.sessionId) return false;

    const scope = grant.scope;
    if (scope.kind === 'call') {
      return scope.tool === subject.tool && scope.fingerprint === subject.fingerprint;
    }
    if (subject.escalated) return false;

    switch (scope.kind) {
      case 'tool':
        return scope.tool === subject.tool;
      case 'tier':
        return (
          tierCovers(scope.tier, subject.tier) &&
          (!scope.provider || scope.provider === subject.provider)
        );
      case 'provider':
        return scope.provider === subject.provider;
      case 'profile':
        return this.options.profileCovers?.(scope.profile, subject.tool) ?? false;
    }
  }

  private isActive(grant: Grant): boolean {
    if (grant.expiresAt && Date.parse(grant.expiresAt) <= this.now()) return false;
    if (grant.usesRemaining !== undefined && grant.usesRemaining <= 0) return false;
    return true;
  }

  private prune(): void {
    for (const [id, grant] of this.grants) {
      if (!this.isActive(grant)) this.grants.delete(id);
    }
  }
}

export function describeScope(scope: GrantScope): string {
  switch (scope.kind) {
    case 'call':
      return `one ${scope.tool} call`;
    case 'tool':
      return scope.tool;
    case 'tier':
      return `${scope.tier === 'read' ? 'read-only' : 'non-destructive'} tools${scope.provider ? ` from ${scope.provider}` : ''}`;
    case 'provider':
      return `all ${scope.provider} tools`;
    case 'profile':
      return `tools in profile ${scope.profile}`;
  }
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `${hours}h`;
}

/** Parse "15m", "2h", "90s", "1d" or a bare number of minutes. */
export function parseDuration(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/i.exec(text.trim());
  if (!match) return undefined;
  const value = Number(match[1]);
  const unit = (match[2] ?? 'm').toLowerCase();
  const factor =
    unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  const ms = value * factor;
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}
