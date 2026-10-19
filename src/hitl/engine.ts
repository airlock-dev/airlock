import { generateId, generateApprovalCode } from '../util/id.js';
import type { AuditLogger } from '../audit/logger.js';
import type { SandboxDisplayInfo } from '../sandbox/index.js';
import type { AirlockCallContext } from '../airlock/context.js';
import type { HitlProvider, ApprovalApi, HitlNotification } from './providers/types.js';
import {
  GrantStore,
  describeScope,
  formatDuration,
  type ApprovalSubject,
  type Grant,
  type GrantOption,
  type GrantScope,
  type GrantSpec,
} from './grants.js';
import { childLogger } from '../util/logger.js';

const log = childLogger('hitl-engine');

export type HitlResult = 'approved' | 'denied' | 'timeout' | 'cancelled';
export type ApprovalMode = 'sync' | 'async';
/** call = a gated tool call; plan = several calls approved up front; question = airlock/ask_user. */
export type ApprovalKind = 'call' | 'plan' | 'question';

export interface HitlTicket {
  id: string;
  code: string;
  result: Promise<HitlResult>;
}

/** One call inside a plan approval. `args` are the redacted args shown to the operator. */
export interface PlanEntry {
  tool: string;
  fingerprint: string;
  args: Record<string, unknown>;
}

export interface ApproveOptions {
  /** Turn this approval into a grant that also covers future (and currently pending) calls. */
  grant?: GrantSpec;
}

export interface ApproveOutcome {
  approved: string[];
  skipped: string[];
  grant?: Grant;
}

export class GrantSpecError extends Error {}

interface PendingRequest {
  id: string;
  code: string;
  agentId: string;
  tool: string;
  args: Record<string, unknown>;
  context?: AirlockCallContext;
  sandbox?: SandboxDisplayInfo;
  kind: ApprovalKind;
  mode: ApprovalMode;
  subject?: ApprovalSubject;
  plan?: PlanEntry[];
  batchId?: string;
  createdAt: string;
  result: Promise<HitlResult>;
  resolve: (result: HitlResult) => void;
  timer?: NodeJS.Timeout; // undefined when timeoutMs === 0 (no timeout)
}

interface StoredMeta {
  kind?: ApprovalKind;
  mode?: ApprovalMode;
  subject?: ApprovalSubject;
  plan?: PlanEntry[];
}

interface BatchRecord {
  id: string;
  code: string;
  agentId: string;
  ids: string[];
}

export interface HitlEngineOptions {
  grants?: GrantStore;
  defaultMode?: ApprovalMode;
  /** Lifetime of the single-use grant an async approval leaves for the agent's retry. */
  asyncGrantTtlMs?: number;
  /** Lifetime of the grants a plan approval creates. */
  planGrantTtlMs?: number;
  /** Duration used when an operator grant doesn't specify one. */
  defaultGrantDurationMs?: number;
  /** Hard cap on any operator grant's duration. */
  maxGrantDurationMs?: number;
  /** How long a denied async call stays denied on retry (stops retry spam). */
  denialMemoryMs?: number;
  /** Profiles whose allow/ask lists cover a tool — offered as grant scopes. */
  profilesForTool?: (tool: string) => string[];
}

export interface ApprovalStatusInfo {
  id: string;
  code: string;
  agentId: string;
  tool: string;
  kind: ApprovalKind;
  status: 'pending' | HitlResult;
}

const DEFAULTS = {
  asyncGrantTtlMs: 30 * 60_000,
  planGrantTtlMs: 30 * 60_000,
  defaultGrantDurationMs: 15 * 60_000,
  maxGrantDurationMs: 24 * 60 * 60_000,
  denialMemoryMs: 5 * 60_000,
};

function redactApprovalArgs(
  auditLogger: AuditLogger,
  args: Record<string, unknown>
): Record<string, unknown> {
  return (
    (
      auditLogger as { redactArgs?: (args: Record<string, unknown>) => Record<string, unknown> }
    ).redactArgs?.(args) ?? args
  );
}

export class HitlEngine implements ApprovalApi {
  private pending = new Map<string, PendingRequest>(); // id → request
  private byCode = new Map<string, string>(); // code → id
  private batches = new Map<string, BatchRecord>(); // batchId → batch
  private batchByCode = new Map<string, string>(); // batch code → batchId
  private recentDenials = new Map<string, number>(); // agentId\0fingerprint → expiry ms
  readonly grants: GrantStore;
  private opts: Required<Omit<HitlEngineOptions, 'grants' | 'profilesForTool'>> &
    Pick<HitlEngineOptions, 'profilesForTool'>;

  constructor(
    private auditLogger: AuditLogger,
    private provider: HitlProvider,
    private _timeoutMs: number,
    options: HitlEngineOptions = {}
  ) {
    this.grants = options.grants ?? new GrantStore(undefined);
    this.opts = {
      defaultMode: options.defaultMode ?? 'sync',
      asyncGrantTtlMs: options.asyncGrantTtlMs ?? DEFAULTS.asyncGrantTtlMs,
      planGrantTtlMs: options.planGrantTtlMs ?? DEFAULTS.planGrantTtlMs,
      defaultGrantDurationMs: options.defaultGrantDurationMs ?? DEFAULTS.defaultGrantDurationMs,
      maxGrantDurationMs: options.maxGrantDurationMs ?? DEFAULTS.maxGrantDurationMs,
      denialMemoryMs: options.denialMemoryMs ?? DEFAULTS.denialMemoryMs,
      profilesForTool: options.profilesForTool,
    };
  }

  get timeoutMs(): number {
    return this._timeoutMs;
  }

  setTimeoutMs(timeoutMs: number): void {
    this._timeoutMs = timeoutMs;
  }

  get defaultMode(): ApprovalMode {
    return this.opts.defaultMode;
  }

  configure(options: Omit<HitlEngineOptions, 'grants'>): void {
    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined) (this.opts as Record<string, unknown>)[key] = value;
    }
  }

  create(params: {
    agentId: string;
    tool: string;
    args: Record<string, unknown>;
    context?: AirlockCallContext;
    sandbox?: SandboxDisplayInfo;
    kind?: ApprovalKind;
    mode?: ApprovalMode;
    subject?: ApprovalSubject;
    plan?: PlanEntry[];
  }): HitlTicket {
    const id = generateId();
    const code = generateApprovalCode();
    const approvalArgs = redactApprovalArgs(this.auditLogger, params.args);
    const createdAt = new Date().toISOString();
    const kind = params.kind ?? 'call';
    const mode = params.mode ?? 'sync';
    const meta: StoredMeta = {
      kind,
      mode,
      ...(params.subject ? { subject: params.subject } : {}),
      ...(params.plan ? { plan: params.plan } : {}),
    };

    // Persist to DB synchronously before returning
    this.auditLogger.insertHitl({
      id,
      code,
      agent_id: params.agentId,
      tool: params.tool,
      args: JSON.stringify(withContext(approvalArgs, params.context)),
      status: 'pending',
      created_at: createdAt,
      meta: JSON.stringify(meta),
    });

    let resolve!: (result: HitlResult) => void;
    const result = new Promise<HitlResult>((r) => (resolve = r));
    const req: PendingRequest = {
      id,
      code,
      agentId: params.agentId,
      tool: params.tool,
      args: approvalArgs,
      ...(params.context ? { context: params.context } : {}),
      ...(params.sandbox ? { sandbox: params.sandbox } : {}),
      kind,
      mode,
      ...(params.subject ? { subject: params.subject } : {}),
      ...(params.plan ? { plan: params.plan } : {}),
      createdAt,
      result,
      resolve,
    };
    this.track(req, this.timeoutMs);

    log.info(
      { id, code, agent: params.agentId, tool: params.tool, kind, mode },
      'HITL request created'
    );
    return { id, code, result };
  }

  /** Redact args the same way approval requests are redacted before display. */
  redact(args: Record<string, unknown>): Record<string, unknown> {
    return redactApprovalArgs(this.auditLogger, args);
  }

  /** The notification payload for a request just created, ready for the batcher. */
  buildNotification(id: string): HitlNotification | undefined {
    const req = this.pending.get(id);
    if (!req) return undefined;
    return this.toNotification(req, this.timeoutMs);
  }

  approve(id: string, options?: ApproveOptions): ApproveOutcome | undefined {
    const req = this.pending.get(id);
    if (!req) {
      log.warn({ id }, 'No pending HITL request found');
      return undefined;
    }
    return this.approveWithOptions(req, options);
  }

  approveByCode(code: string, options?: ApproveOptions): ApproveOutcome | undefined {
    const batchId = this.batchByCode.get(code);
    if (batchId) {
      if (options?.grant) {
        throw new GrantSpecError(
          'A grant needs a single request: approve one request with a duration, not the batch'
        );
      }
      return this.approveBatch(batchId);
    }
    const req = this.resolveRequestByCode(code);
    if (!req) {
      log.warn({ code }, 'No pending HITL request found for approval code');
      return undefined;
    }
    return this.approveWithOptions(req, options);
  }

  /** Cancel a pending request (e.g. transport disconnected). */
  cancel(id: string): void {
    const req = this.pending.get(id);
    if (!req) return;
    this.finish(req, 'cancelled');
    log.info({ id: req.id, code: req.code }, 'HITL cancelled (session disconnected)');
  }

  deny(id: string, reason?: string): void {
    const req = this.pending.get(id);
    if (!req) {
      log.warn({ id }, 'No pending HITL request found');
      return;
    }
    this.denyRequest(req, reason);
  }

  denyByCode(code: string, reason?: string): void {
    const batchId = this.batchByCode.get(code);
    if (batchId) {
      this.denyBatch(batchId, reason);
      return;
    }
    const req = this.resolveRequestByCode(code);
    if (!req) {
      log.warn({ code }, 'No pending HITL request found for approval code');
      return;
    }
    this.denyRequest(req, reason);
  }

  /**
   * Approve an explicit list of requests in one decision. Bulk approval is for routine tool calls:
   * escalated calls (flagged by a detector or command policy) are skipped unless
   * `includeEscalated` is set, and plans and ask_user questions are always skipped — a plan mints
   * grants and a question needs reading, so each deserves its own look.
   */
  approveMany(ids: string[], opts: { includeEscalated?: boolean } = {}): ApproveOutcome {
    const approved: string[] = [];
    const skipped: string[] = [];
    for (const id of ids) {
      const req = this.pending.get(id);
      if (!req || req.kind !== 'call' || (req.subject?.escalated && !opts.includeEscalated)) {
        skipped.push(id);
        continue;
      }
      this.approveRequest(req);
      approved.push(id);
    }
    log.info({ approved: approved.length, skipped: skipped.length }, 'HITL bulk approve');
    return { approved, skipped };
  }

  denyMany(ids: string[], reason?: string): string[] {
    const denied: string[] = [];
    for (const id of ids) {
      const req = this.pending.get(id);
      if (!req) continue;
      this.denyRequest(req, reason);
      denied.push(id);
    }
    return denied;
  }

  /** Approve every still-pending, non-escalated member of a notification batch. */
  approveBatch(batchIdOrCode: string): ApproveOutcome | undefined {
    const batch = this.getBatch(batchIdOrCode);
    if (!batch) return undefined;
    return this.approveMany(batch.ids);
  }

  denyBatch(batchIdOrCode: string, reason?: string): string[] | undefined {
    const batch = this.getBatch(batchIdOrCode);
    if (!batch) return undefined;
    return this.denyMany(batch.ids, reason);
  }

  /**
   * Snapshot a set of requests notified together. Returns undefined for a single request — a
   * batch of one is just a request. "Approve all" only ever covers this snapshot, never requests
   * that arrived after the operator was shown the batch.
   */
  registerBatch(ids: string[]): { batchId: string; batchCode: string } | undefined {
    const members = ids.filter((id) => this.pending.has(id));
    if (members.length < 2) return undefined;
    const batch: BatchRecord = {
      id: generateId(),
      code: generateApprovalCode(),
      agentId: this.pending.get(members[0])!.agentId,
      ids: members,
    };
    this.batches.set(batch.id, batch);
    this.batchByCode.set(batch.code, batch.id);
    for (const id of members) this.pending.get(id)!.batchId = batch.id;
    return { batchId: batch.id, batchCode: batch.code };
  }

  hasBatch(batchIdOrCode: string): boolean {
    return this.getBatch(batchIdOrCode) !== undefined;
  }

  getPending(): Array<{
    id: string;
    code: string;
    agentId: string;
    tool: string;
    args: Record<string, unknown>;
    context?: AirlockCallContext;
    kind: ApprovalKind;
    mode: ApprovalMode;
    tier?: string;
    provider?: string;
    escalated?: boolean;
    plan?: PlanEntry[];
    batchId?: string;
    batchCode?: string;
    grantOptions?: GrantOption[];
  }> {
    return Array.from(this.pending.values()).map((r) => {
      const batch = r.batchId ? this.batches.get(r.batchId) : undefined;
      const grantOptions = this.grantOptionsFor(r);
      return {
        id: r.id,
        code: r.code,
        agentId: r.agentId,
        tool: r.tool,
        args: r.args,
        ...(r.context ? { context: r.context } : {}),
        ...(r.sandbox ? { sandbox: r.sandbox } : {}),
        kind: r.kind,
        mode: r.mode,
        ...(r.subject
          ? { tier: r.subject.tier, provider: r.subject.provider, escalated: r.subject.escalated }
          : {}),
        ...(r.plan ? { plan: r.plan } : {}),
        ...(batch ? { batchId: batch.id, batchCode: batch.code } : {}),
        ...(grantOptions.length > 0 ? { grantOptions } : {}),
      };
    });
  }

  hasPending(id: string): boolean {
    return this.pending.has(id);
  }

  getPreviewRequest(
    id: string
  ): Pick<PendingRequest, 'id' | 'agentId' | 'tool' | 'args'> | undefined {
    return this.pending.get(id);
  }

  // ── Grants ────────────────────────────────────────────────────────────────

  /** Consume a grant covering this call, if one exists. */
  consumeGrant(subject: ApprovalSubject): Grant | undefined {
    return this.grants.consume(subject);
  }

  /** Create a grant directly (operator pre-approval, not tied to a request). */
  createOperatorGrant(params: {
    agentId: string;
    scope: GrantScope;
    durationMs?: number;
    maxUses?: number;
  }): Grant {
    if (params.scope.kind === 'call') {
      throw new GrantSpecError('call grants are created by plans and async approvals only');
    }
    if (params.maxUses !== undefined && (!Number.isInteger(params.maxUses) || params.maxUses < 1)) {
      throw new GrantSpecError('maxUses must be a whole number of at least 1');
    }
    const durationMs = this.clampDuration(params.durationMs);
    const grant = this.grants.create({
      agentId: params.agentId,
      scope: params.scope,
      source: 'operator',
      label: `${describeScope(params.scope)} for ${formatDuration(durationMs)}`,
      expiresAt: new Date(Date.now() + durationMs).toISOString(),
      ...(params.maxUses !== undefined ? { usesRemaining: params.maxUses } : {}),
    });
    this.sweepPending(grant);
    return grant;
  }

  listGrants(agentId?: string): Grant[] {
    return this.grants.list(agentId);
  }

  revokeGrant(id: string): boolean {
    return this.grants.revoke(id);
  }

  // ── Async support ─────────────────────────────────────────────────────────

  /** A pending async request for the same exact call, so retries don't create duplicates. */
  findPendingCall(agentId: string, fingerprint: string): { id: string; code: string } | undefined {
    for (const req of this.pending.values()) {
      if (
        req.agentId === agentId &&
        req.subject?.fingerprint === fingerprint &&
        req.kind === 'call'
      ) {
        return { id: req.id, code: req.code };
      }
    }
    return undefined;
  }

  wasRecentlyDenied(agentId: string, fingerprint: string): boolean {
    const key = `${agentId}\0${fingerprint}`;
    const expiry = this.recentDenials.get(key);
    if (expiry === undefined) return false;
    if (expiry <= Date.now()) {
      this.recentDenials.delete(key);
      return false;
    }
    return true;
  }

  /** Status of an approval the given agent owns, or undefined if it isn't theirs / doesn't exist. */
  getStatus(id: string, agentId: string): ApprovalStatusInfo | undefined {
    const req = this.pending.get(id);
    if (req) {
      if (req.agentId !== agentId) return undefined;
      return { id, code: req.code, agentId, tool: req.tool, kind: req.kind, status: 'pending' };
    }
    const row = (this.auditLogger as { getHitlById?: AuditLogger['getHitlById'] }).getHitlById?.(
      id
    );
    if (!row || row.agent_id !== agentId) return undefined;
    const meta = parseMeta(row.meta);
    return {
      id,
      code: row.code,
      agentId,
      tool: row.tool,
      kind: meta.kind ?? 'call',
      status: row.status,
    };
  }

  /** Wait up to `waitMs` for an approval to resolve. */
  async waitFor(
    id: string,
    agentId: string,
    waitMs: number
  ): Promise<ApprovalStatusInfo | undefined> {
    const req = this.pending.get(id);
    if (req && req.agentId === agentId && waitMs > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        req.result,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, waitMs);
          timer.unref();
        }),
      ]);
      clearTimeout(timer);
    }
    return this.getStatus(id, agentId);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private getBatch(batchIdOrCode: string): BatchRecord | undefined {
    const batchId = this.batchByCode.get(batchIdOrCode) ?? batchIdOrCode;
    return this.batches.get(batchId);
  }

  private resolveRequestByCode(code: string): PendingRequest | undefined {
    const id = this.byCode.get(code);
    if (id) return this.pending.get(id);
    return undefined;
  }

  private track(req: PendingRequest, timeoutMs: number): void {
    this.pending.set(req.id, req);
    this.byCode.set(req.code, req.id);
    if (timeoutMs > 0) {
      const timer = setTimeout(() => {
        log.warn({ id: req.id, code: req.code, tool: req.tool }, 'HITL request timed out');
        this.finish(req, 'timeout');
      }, timeoutMs);
      timer.unref();
      req.timer = timer;
    }
  }

  private approveWithOptions(req: PendingRequest, options?: ApproveOptions): ApproveOutcome {
    // Validate the grant before approving so a bad spec rejects the whole decision.
    const spec = options?.grant;
    const scope = spec ? this.scopeFromSpec(req, spec) : undefined;
    if (spec?.maxUses !== undefined && (!Number.isInteger(spec.maxUses) || spec.maxUses < 1)) {
      throw new GrantSpecError('maxUses must be a whole number of at least 1');
    }
    if (spec?.sessionOnly && !req.subject?.sessionId) {
      // Never silently widen a session-only grant to every session of the agent.
      throw new GrantSpecError('This request has no session to bind a session-only grant to');
    }
    this.approveRequest(req);
    if (!scope || !spec) return { approved: [req.id], skipped: [] };

    // The approval that creates the grant counts as its first use.
    const usesRemaining = spec.maxUses !== undefined ? spec.maxUses - 1 : undefined;
    if (usesRemaining === 0) return { approved: [req.id], skipped: [] };

    const durationMs = this.clampDuration(spec.durationMs);
    const grant = this.grants.create({
      agentId: req.agentId,
      ...(spec.sessionOnly ? { sessionId: req.subject!.sessionId } : {}),
      scope,
      source: 'approval',
      approvalId: req.id,
      label: `${describeScope(scope)} for ${formatDuration(durationMs)}`,
      expiresAt: new Date(Date.now() + durationMs).toISOString(),
      ...(usesRemaining !== undefined ? { usesRemaining } : {}),
    });
    const alsoApproved = this.sweepPending(grant);
    return { approved: [req.id, ...alsoApproved], skipped: [], grant };
  }

  /** Resolve every other pending call the new grant covers — e.g. the 9 queued email reads. */
  private sweepPending(grant: Grant): string[] {
    const approved: string[] = [];
    const only = new Set([grant.id]);
    for (const other of [...this.pending.values()]) {
      if (other.kind !== 'call' || !other.subject) continue;
      if (!this.grants.covers(grant, other.subject)) continue;
      // Every auto-approval spends a use, so maxUses holds. (An async request then also gets its
      // own single-use call grant, which its retry consumes first.)
      if (!this.grants.consume(other.subject, only)) break;
      this.approveRequest(other);
      approved.push(other.id);
    }
    if (approved.length > 0) {
      log.info({ grantId: grant.id, count: approved.length }, 'Grant auto-approved pending calls');
    }
    return approved;
  }

  private scopeFromSpec(req: PendingRequest, spec: GrantSpec): GrantScope {
    const subject = req.subject;
    if (!subject || req.kind !== 'call') {
      throw new GrantSpecError('Only tool-call approvals can be turned into a grant');
    }
    if (subject.escalated) {
      throw new GrantSpecError(
        'This call was flagged for review by a security check; it cannot be widened into a grant'
      );
    }
    switch (spec.scope) {
      case 'tool':
        return { kind: 'tool', tool: subject.tool };
      case 'tier': {
        const tier = spec.tier ?? (subject.tier === 'read' ? 'read' : 'write');
        return {
          kind: 'tier',
          tier,
          ...(spec.sameProvider === false ? {} : { provider: subject.provider }),
        };
      }
      case 'provider':
        return { kind: 'provider', provider: subject.provider };
      case 'profile': {
        if (!spec.profile) throw new GrantSpecError('profile is required for a profile grant');
        const known = this.opts.profilesForTool?.(subject.tool) ?? [];
        if (!known.includes(spec.profile)) {
          throw new GrantSpecError(`Profile ${spec.profile} does not cover ${subject.tool}`);
        }
        return { kind: 'profile', profile: spec.profile };
      }
      default:
        throw new GrantSpecError(`Unknown grant scope: ${String(spec.scope)}`);
    }
  }

  private grantOptionsFor(req: PendingRequest): GrantOption[] {
    const subject = req.subject;
    if (req.kind !== 'call' || !subject || subject.escalated) return [];
    const options: GrantOption[] = [{ scope: 'tool', label: `Allow ${subject.tool}` }];
    if (subject.tier === 'read') {
      options.push({
        scope: 'tier',
        tier: 'read',
        label: `Allow read-only ${subject.provider} tools`,
      });
    } else if (subject.tier === 'write') {
      options.push({
        scope: 'tier',
        tier: 'write',
        label: `Allow non-destructive ${subject.provider} tools`,
      });
    }
    options.push({ scope: 'provider', label: `Allow all ${subject.provider} tools` });
    for (const profile of this.opts.profilesForTool?.(subject.tool) ?? []) {
      options.push({ scope: 'profile', profile, label: `Allow profile ${profile}` });
    }
    return options;
  }

  private clampDuration(durationMs: number | undefined): number {
    const requested = durationMs && durationMs > 0 ? durationMs : this.opts.defaultGrantDurationMs;
    return Math.min(requested, this.opts.maxGrantDurationMs);
  }

  private approveRequest(req: PendingRequest): void {
    this.finish(req, 'approved');
    log.info({ id: req.id, code: req.code }, 'HITL approved');

    if (req.kind === 'call' && req.mode === 'async' && req.subject) {
      // The agent got an immediate "pending" answer; leave a single-use grant so its retry of the
      // exact same call goes through.
      this.grants.create({
        agentId: req.agentId,
        scope: { kind: 'call', tool: req.subject.tool, fingerprint: req.subject.fingerprint },
        source: 'async',
        approvalId: req.id,
        label: `retry of ${req.subject.tool}`,
        expiresAt: new Date(Date.now() + this.opts.asyncGrantTtlMs).toISOString(),
        usesRemaining: 1,
      });
    }

    if (req.kind === 'plan' && req.plan) {
      const counts = new Map<string, { entry: PlanEntry; count: number }>();
      for (const entry of req.plan) {
        const existing = counts.get(entry.fingerprint);
        if (existing) existing.count += 1;
        else counts.set(entry.fingerprint, { entry, count: 1 });
      }
      const expiresAt = new Date(Date.now() + this.opts.planGrantTtlMs).toISOString();
      for (const [fingerprint, { entry, count }] of counts) {
        const tool = entry.tool;
        const summary = argsSummary(entry.args);
        this.grants.create({
          agentId: req.agentId,
          scope: { kind: 'call', tool, fingerprint },
          source: 'plan',
          approvalId: req.id,
          label: summary ? `planned ${tool} (${summary})` : `planned ${tool}`,
          expiresAt,
          usesRemaining: count,
        });
      }
    }
  }

  private denyRequest(req: PendingRequest, reason?: string): void {
    this.finish(req, 'denied', reason);
    log.info({ id: req.id, code: req.code, reason }, 'HITL denied');
    if (req.mode === 'async' && req.subject) {
      const now = Date.now();
      for (const [key, expiry] of this.recentDenials) {
        if (expiry <= now) this.recentDenials.delete(key);
      }
      this.recentDenials.set(
        `${req.agentId}\0${req.subject.fingerprint}`,
        Date.now() + this.opts.denialMemoryMs
      );
    }
  }

  private finish(req: PendingRequest, result: HitlResult, reason?: string): void {
    if (req.timer) clearTimeout(req.timer);
    this.pending.delete(req.id);
    this.byCode.delete(req.code);
    if (reason === undefined) this.auditLogger.updateHitlStatus(req.id, result);
    else this.auditLogger.updateHitlStatus(req.id, result, reason);
    this.updateApprovalStatus(req, result);
    this.releaseBatch(req.batchId);
    req.resolve(result);
  }

  /** Pending members left in a batch; forgets the batch once none are. */
  private releaseBatch(batchId: string | undefined): number | undefined {
    if (!batchId) return undefined;
    const batch = this.batches.get(batchId);
    if (!batch) return undefined;
    const remaining = batch.ids.filter((id) => this.pending.has(id)).length;
    if (remaining === 0) {
      this.batches.delete(batch.id);
      this.batchByCode.delete(batch.code);
    }
    return remaining;
  }

  private toNotification(req: PendingRequest, timeoutMs: number): HitlNotification {
    const grantOptions = this.grantOptionsFor(req);
    return {
      id: req.id,
      code: req.code,
      agentId: req.agentId,
      tool: req.tool,
      args: req.args,
      ...(req.context ? { context: req.context } : {}),
      ...(req.sandbox ? { sandbox: req.sandbox } : {}),
      timeoutMs,
      kind: req.kind,
      ...(req.subject
        ? {
            tier: req.subject.tier,
            provider: req.subject.provider,
            escalated: req.subject.escalated,
          }
        : {}),
      ...(req.plan ? { plan: req.plan } : {}),
      ...(grantOptions.length > 0 ? { grantOptions } : {}),
    };
  }

  /** Recover pending requests from DB on startup */
  // eslint-disable-next-line @typescript-eslint/require-await
  async recoverPending(): Promise<void> {
    this.grants.load();
    const rows = this.auditLogger.getPendingHitl();
    if (rows.length === 0) return;

    log.info({ count: rows.length }, 'Recovering pending HITL requests from DB');

    for (const row of rows) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(row.args) as Record<string, unknown>;
      } catch {
        log.warn({ id: row.id }, 'Failed to parse HITL args from DB, using empty args');
      }

      let remaining: number;
      if (this.timeoutMs > 0) {
        const elapsed = Date.now() - new Date(row.created_at).getTime();
        remaining = this.timeoutMs - elapsed;

        if (remaining <= 0) {
          this.auditLogger.updateHitlStatus(row.id, 'timeout');
          this.updateApprovalStatus({ id: row.id, code: row.code }, 'timeout');
          continue;
        }
      } else {
        remaining = 0; // no timeout
      }

      const context = readContext(args);
      const cleanArgs = stripStoredContext(args);
      const meta = parseMeta(row.meta);

      // Re-arm without re-notifying (provider may not be ready yet)
      let resolve!: (result: HitlResult) => void;
      const result = new Promise<HitlResult>((r) => (resolve = r));
      const req: PendingRequest = {
        id: row.id,
        code: row.code,
        agentId: row.agent_id,
        tool: row.tool,
        args: cleanArgs,
        ...(context ? { context } : {}),
        kind: meta.kind ?? 'call',
        // A sync caller's held-open call died with the old process; only async requests (whose
        // agent will retry) and plans are still worth resolving.
        mode: meta.mode ?? 'sync',
        ...(meta.subject ? { subject: meta.subject } : {}),
        ...(meta.plan ? { plan: meta.plan } : {}),
        createdAt: row.created_at,
        result,
        resolve,
      };
      this.track(req, remaining);

      // Notify again so operator sees recovered requests
      void this.provider
        .notify([{ ...this.toNotification(req, remaining), badgeCount: this.pending.size }])
        .catch((err) => log.warn({ err }, 'Failed to re-notify recovered HITL request'));
    }
  }

  private updateApprovalStatus(
    req: Pick<PendingRequest, 'id' | 'code'> & { batchId?: string },
    result: HitlResult
  ): void {
    const badgeCount = this.pending.size;
    const batchPending = this.releaseBatch(req.batchId);
    if (this.provider.updateApprovalStatus) {
      void this.provider
        .updateApprovalStatus({
          id: req.id,
          code: req.code,
          result,
          badgeCount,
          ...(req.batchId && batchPending !== undefined
            ? { batchId: req.batchId, batchPending }
            : {}),
        })
        .catch((err) => log.warn({ err }, 'Failed to update approval status'));
      return;
    }

    void this.provider
      .updateBadge?.(badgeCount)
      .catch((err) => log.warn({ err }, 'Failed to update approval badge count'));
  }
}

/** Short "key: value" summary so several planned calls to one tool are distinguishable. */
function argsSummary(args: Record<string, unknown>): string {
  const text = Object.entries(args)
    .slice(0, 2)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(', ');
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function parseMeta(raw: string | null | undefined): StoredMeta {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as StoredMeta;
  } catch {
    return {};
  }
}

function withContext(
  args: Record<string, unknown>,
  context: AirlockCallContext | undefined
): Record<string, unknown> {
  if (!context) return args;
  return { ...args, _airlock: context };
}

function readContext(args: Record<string, unknown>): AirlockCallContext | undefined {
  const raw = args._airlock;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const context: AirlockCallContext = {};
  if (typeof source.reason === 'string') context.reason = source.reason;
  if (typeof source.note === 'string') context.note = source.note;
  return context.reason || context.note ? context : undefined;
}

function stripStoredContext(args: Record<string, unknown>): Record<string, unknown> {
  const { _airlock: _ignored, ...cleanArgs } = args;
  return cleanArgs;
}
