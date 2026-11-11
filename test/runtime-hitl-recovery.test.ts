import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AuditLogger } from '../src/audit/logger.js';
import { HitlEngine } from '../src/hitl/engine.js';

function makeProvider() {
  return {
    init: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn().mockResolvedValue(undefined),
    updateApprovalStatus: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

describe('HitlEngine.recoverPending', () => {
  const dirs: string[] = [];
  const loggers: AuditLogger[] = [];

  afterEach(() => {
    for (const logger of loggers.splice(0)) logger.stop();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeLogger(): AuditLogger {
    const dir = mkdtempSync(join(tmpdir(), 'airlock-runtime-recovery-'));
    dirs.push(dir);
    const logger = new AuditLogger({
      db_path: join(dir, 'audit.db'),
      redact_fields: [],
      retention_days: 30,
    });
    loggers.push(logger);
    return logger;
  }

  function insert(
    logger: AuditLogger,
    id: string,
    meta: Record<string, unknown> | undefined
  ): void {
    logger.insertHitl({
      id,
      code: id.toUpperCase().padEnd(8, 'X').slice(0, 8),
      agent_id: 'agent',
      tool: 'github/create_issue',
      args: '{}',
      status: 'pending',
      created_at: new Date().toISOString(),
      meta: meta ? JSON.stringify(meta) : null,
    });
  }

  it('cancels sync calls and questions whose caller died, and re-arms async calls and plans', async () => {
    const logger = makeLogger();
    insert(logger, 'synccall', { kind: 'call', mode: 'sync' });
    insert(logger, 'legacyrow', undefined);
    insert(logger, 'question', { kind: 'question', mode: 'sync' });
    insert(logger, 'asynccall', { kind: 'call', mode: 'async' });
    insert(logger, 'syncplan', { kind: 'plan', mode: 'sync', plan: [] });

    const provider = makeProvider();
    const engine = new HitlEngine(logger, provider, 60_000);
    await engine.recoverPending();

    for (const id of ['synccall', 'legacyrow', 'question']) {
      expect(engine.hasPending(id)).toBe(false);
      expect(logger.getHitlById(id)?.status).toBe('cancelled');
      expect(provider.updateApprovalStatus).toHaveBeenCalledWith(
        expect.objectContaining({ id, result: 'cancelled' })
      );
    }
    for (const id of ['asynccall', 'syncplan']) {
      expect(engine.hasPending(id)).toBe(true);
      expect(logger.getHitlById(id)?.status).toBe('pending');
    }
    const notified = provider.notify.mock.calls.flatMap(([requests]) =>
      (requests as Array<{ id: string }>).map((request) => request.id)
    );
    expect(notified.sort()).toEqual(['asynccall', 'syncplan']);
    expect(engine.pendingCount()).toBe(2);
  });
});
