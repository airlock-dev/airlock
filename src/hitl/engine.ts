import { generateId, generateApprovalCode } from '../util/id.js';
import type { AuditLogger } from '../audit/logger.js';
import type { HitlProvider, ApprovalApi } from './providers/types.js';
import { childLogger } from '../util/logger.js';

const log = childLogger('hitl-engine');

export type HitlResult = 'approved' | 'denied' | 'timeout';

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
  resolve: (result: HitlResult) => void;
  timer: NodeJS.Timeout;
}

export class HitlEngine implements ApprovalApi {
  private pending = new Map<string, PendingRequest>(); // id → request
  private byCode  = new Map<string, string>();          // code → id

  constructor(
    private auditLogger: AuditLogger,
    private provider: HitlProvider,
    readonly timeoutMs: number,
  ) {}

  create(params: {
    agentId: string;
    tool: string;
    args: Record<string, unknown>;
  }): HitlTicket {
    const id   = generateId();
    const code = generateApprovalCode();

    // Persist to DB synchronously before returning
    this.auditLogger.insertHitl({
      id,
      code,
      agent_id: params.agentId,
      tool: params.tool,
      args: JSON.stringify(params.args),
      status: 'pending',
      created_at: new Date().toISOString(),
    });

    const result = new Promise<HitlResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.byCode.delete(code);
        this.auditLogger.updateHitlStatus(id, 'timeout');
        log.warn({ id, code, tool: params.tool }, 'HITL request timed out');
        resolve('timeout');
      }, this.timeoutMs);
      timer.unref();

      const req: PendingRequest = { id, code, ...params, resolve, timer };
      this.pending.set(id, req);
      this.byCode.set(code, id);
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
    clearTimeout(req.timer);
    this.pending.delete(req.id);
    this.byCode.delete(req.code);
    this.auditLogger.updateHitlStatus(req.id, 'approved');
    log.info({ id: req.id, code: req.code }, 'HITL approved');
    req.resolve('approved');
  }

  /** Deny by code or id */
  deny(codeOrId: string, reason?: string): void {
    const req = this.resolveRequest(codeOrId);
    if (!req) {
      log.warn({ codeOrId }, 'No pending HITL request found');
      return;
    }
    clearTimeout(req.timer);
    this.pending.delete(req.id);
    this.byCode.delete(req.code);
    this.auditLogger.updateHitlStatus(req.id, 'denied', reason);
    log.info({ id: req.id, code: req.code, reason }, 'HITL denied');
    req.resolve('denied');
  }

  getPending(): Array<{ id: string; code: string; agentId: string; tool: string; args: Record<string, unknown> }> {
    return Array.from(this.pending.values()).map(r => ({
      id: r.id, code: r.code, agentId: r.agentId, tool: r.tool, args: r.args,
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
  async recoverPending(): Promise<void> {
    const rows = this.auditLogger.getPendingHitl();
    if (rows.length === 0) return;

    log.info({ count: rows.length }, 'Recovering pending HITL requests from DB');

    for (const row of rows) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(row.args); } catch {
        log.warn({ id: row.id }, 'Failed to parse HITL args from DB, using empty args');
      }

      const elapsed = Date.now() - new Date(row.created_at).getTime();
      const remaining = this.timeoutMs - elapsed;

      if (remaining <= 0) {
        this.auditLogger.updateHitlStatus(row.id, 'timeout');
        continue;
      }

      // Re-arm without re-notifying (provider may not be ready yet)
      const promise = new Promise<HitlResult>((resolve) => {
        const timer = setTimeout(() => {
          this.pending.delete(row.id);
          this.byCode.delete(row.code);
          this.auditLogger.updateHitlStatus(row.id, 'timeout');
          resolve('timeout');
        }, remaining);
        timer.unref();

        const req: PendingRequest = {
          id: row.id, code: row.code, agentId: row.agent_id,
          tool: row.tool, args, resolve, timer,
        };
        this.pending.set(row.id, req);
        this.byCode.set(row.code, row.id);
      });

      // Notify again so operator sees recovered requests
      void this.provider.notify([{
        id: row.id, code: row.code, agentId: row.agent_id,
        tool: row.tool, args, timeoutMs: remaining,
      }]).catch(err => log.warn({ err }, 'Failed to re-notify recovered HITL request'));

      void promise; // tracked in pending map
    }
  }
}
