import { generateId, generateApprovalCode } from '../util/id.js';
import type { AuditLogger } from '../audit/logger.js';
import type { SandboxDisplayInfo } from '../sandbox/index.js';
import type { AirlockCallContext } from '../airlock/context.js';
import type { HitlProvider, ApprovalApi } from './providers/types.js';
import { childLogger } from '../util/logger.js';

const log = childLogger('hitl-engine');

export type HitlResult = 'approved' | 'denied' | 'timeout' | 'cancelled';

export interface HitlTicket {
  id: string;
  code: string;
  result: Promise<HitlResult>;
}

interface PendingRequest {
  id: string;
  code: string;
  agentId: string;
  tool: string;
  args: Record<string, unknown>;
  context?: AirlockCallContext;
  sandbox?: SandboxDisplayInfo;
  resolve: (result: HitlResult) => void;
  timer?: NodeJS.Timeout; // undefined when timeoutMs === 0 (no timeout)
}

function redactApprovalArgs(
  auditLogger: AuditLogger,
  args: Record<string, unknown>
): Record<string, unknown> {
  return (
    (auditLogger as { redactArgs?: (args: Record<string, unknown>) => Record<string, unknown> })
      .redactArgs?.(args) ?? args
  );
}

export class HitlEngine implements ApprovalApi {
  private pending = new Map<string, PendingRequest>(); // id → request
  private byCode = new Map<string, string>(); // code → id

  constructor(
    private auditLogger: AuditLogger,
    private provider: HitlProvider,
    private _timeoutMs: number
  ) {}

  get timeoutMs(): number {
    return this._timeoutMs;
  }

  setTimeoutMs(timeoutMs: number): void {
    this._timeoutMs = timeoutMs;
  }

  create(params: {
    agentId: string;
    tool: string;
    args: Record<string, unknown>;
    context?: AirlockCallContext;
    sandbox?: SandboxDisplayInfo;
  }): HitlTicket {
    const id = generateId();
    const code = generateApprovalCode();
    const approvalArgs = redactApprovalArgs(this.auditLogger, params.args);

    // Persist to DB synchronously before returning
    this.auditLogger.insertHitl({
      id,
      code,
      agent_id: params.agentId,
      tool: params.tool,
      args: JSON.stringify(withContext(approvalArgs, params.context)),
      status: 'pending',
      created_at: new Date().toISOString(),
    });

    const result = new Promise<HitlResult>((resolve) => {
      const req: PendingRequest = { id, code, ...params, args: approvalArgs, resolve };
      this.pending.set(id, req);
      this.byCode.set(code, id);

      if (this.timeoutMs > 0) {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          this.byCode.delete(code);
          this.auditLogger.updateHitlStatus(id, 'timeout');
          log.warn({ id, code, tool: params.tool }, 'HITL request timed out');
          this.updateApprovalStatus(req, 'timeout');
          resolve('timeout');
        }, this.timeoutMs);
        timer.unref();
        req.timer = timer;
      }
    });

    log.info({ id, code, agent: params.agentId, tool: params.tool }, 'HITL request created');
    return { id, code, result };
  }

  /** Approve by code (used by providers) or by id (used by API) */
  approve(codeOrId: string): void {
    const req = this.resolveRequest(codeOrId);
    if (!req) {
      log.warn({ codeOrId }, 'No pending HITL request found');
      return;
    }
    if (req.timer) clearTimeout(req.timer);
    this.pending.delete(req.id);
    this.byCode.delete(req.code);
    this.auditLogger.updateHitlStatus(req.id, 'approved');
    log.info({ id: req.id, code: req.code }, 'HITL approved');
    this.updateApprovalStatus(req, 'approved');
    req.resolve('approved');
  }

  /** Cancel a pending request (e.g. transport disconnected). */
  cancel(id: string): void {
    const req = this.pending.get(id);
    if (!req) return;
    if (req.timer) clearTimeout(req.timer);
    this.pending.delete(req.id);
    this.byCode.delete(req.code);
    this.auditLogger.updateHitlStatus(req.id, 'cancelled');
    log.info({ id: req.id, code: req.code }, 'HITL cancelled (session disconnected)');
    this.updateApprovalStatus(req, 'cancelled');
    req.resolve('cancelled');
  }

  /** Deny by code or id */
  deny(codeOrId: string, reason?: string): void {
    const req = this.resolveRequest(codeOrId);
    if (!req) {
      log.warn({ codeOrId }, 'No pending HITL request found');
      return;
    }
    if (req.timer) clearTimeout(req.timer);
    this.pending.delete(req.id);
    this.byCode.delete(req.code);
    this.auditLogger.updateHitlStatus(req.id, 'denied', reason);
    log.info({ id: req.id, code: req.code, reason }, 'HITL denied');
    this.updateApprovalStatus(req, 'denied');
    req.resolve('denied');
  }

  getPending(): Array<{
    id: string;
    code: string;
    agentId: string;
    tool: string;
    args: Record<string, unknown>;
    context?: AirlockCallContext;
  }> {
    return Array.from(this.pending.values()).map((r) => ({
      id: r.id,
      code: r.code,
      agentId: r.agentId,
      tool: r.tool,
      args: r.args,
      ...(r.context ? { context: r.context } : {}),
      ...(r.sandbox ? { sandbox: r.sandbox } : {}),
    }));
  }

  private resolveRequest(codeOrId: string): PendingRequest | undefined {
    // Try as id first
    if (this.pending.has(codeOrId)) return this.pending.get(codeOrId);
    // Try as code
    const id = this.byCode.get(codeOrId);
    if (id) return this.pending.get(id);
    return undefined;
  }

  /** Recover pending requests from DB on startup */
  // eslint-disable-next-line @typescript-eslint/require-await
  async recoverPending(): Promise<void> {
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

      // Re-arm without re-notifying (provider may not be ready yet)
      const promise = new Promise<HitlResult>((resolve) => {
        const req: PendingRequest = {
          id: row.id,
          code: row.code,
          agentId: row.agent_id,
          tool: row.tool,
          args: cleanArgs,
          ...(context ? { context } : {}),
          resolve,
        };
        this.pending.set(row.id, req);
        this.byCode.set(row.code, row.id);

        if (remaining > 0) {
          const timer = setTimeout(() => {
            this.pending.delete(row.id);
            this.byCode.delete(row.code);
            this.auditLogger.updateHitlStatus(row.id, 'timeout');
            this.updateApprovalStatus(req, 'timeout');
            resolve('timeout');
          }, remaining);
          timer.unref();
          req.timer = timer;
        }
      });

      // Notify again so operator sees recovered requests
      void this.provider
        .notify([
          {
            id: row.id,
            code: row.code,
            agentId: row.agent_id,
            tool: row.tool,
            args: cleanArgs,
            ...(context ? { context } : {}),
            sandbox: undefined,
            timeoutMs: remaining,
            badgeCount: this.getPending().length,
          },
        ])
        .catch((err) => log.warn({ err }, 'Failed to re-notify recovered HITL request'));

      void promise; // tracked in pending map
    }
  }

  private updateApprovalStatus(req: Pick<PendingRequest, 'id' | 'code'>, result: HitlResult): void {
    const badgeCount = this.getPending().length;
    if (this.provider.updateApprovalStatus) {
      void this.provider
        .updateApprovalStatus({ id: req.id, code: req.code, result, badgeCount })
        .catch((err) => log.warn({ err }, 'Failed to update approval status'));
      return;
    }

    void this.provider
      .updateBadge?.(badgeCount)
      .catch((err) => log.warn({ err }, 'Failed to update approval badge count'));
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
