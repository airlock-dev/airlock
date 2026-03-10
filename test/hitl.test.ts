import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HitlEngine } from '../src/hitl/engine.js';
import { HitlBatcher } from '../src/hitl/batcher.js';

// Minimal mock audit logger
function makeMockAuditLogger() {
  return {
    insertHitl: vi.fn(),
    updateHitlStatus: vi.fn(),
    getHitlByCode: vi.fn(),
    getHitlById: vi.fn(),
    getPendingHitl: vi.fn().mockReturnValue([]),
    log: vi.fn(),
    query: vi.fn(),
    recent: vi.fn(),
    startDailyCleanup: vi.fn(),
    stop: vi.fn(),
  } as unknown as import('../src/audit/logger.js').AuditLogger;
}

function makeMockProvider() {
  return {
    init: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

describe('HitlEngine', () => {
  let engine: HitlEngine;
  let auditLogger: ReturnType<typeof makeMockAuditLogger>;
  let provider: ReturnType<typeof makeMockProvider>;

  beforeEach(() => {
    auditLogger = makeMockAuditLogger();
    provider = makeMockProvider();
    engine = new HitlEngine(auditLogger, provider, 5000);
  });

  it('resolves approved when approve() called by code', async () => {
    const promise = engine.request({ agentId: 'agent1', tool: 'github/create_pr', args: {} });

    // Get the code from the DB insert call
    const call = (auditLogger.insertHitl as ReturnType<typeof vi.fn>).mock.calls[0][0];
    engine.approve(call.code);

    const result = await promise;
    expect(result).toBe('approved');
  });

  it('resolves denied when deny() called', async () => {
    const promise = engine.request({ agentId: 'agent1', tool: 'github/create_pr', args: {} });

    const call = (auditLogger.insertHitl as ReturnType<typeof vi.fn>).mock.calls[0][0];
    engine.deny(call.code, 'not today');

    const result = await promise;
    expect(result).toBe('denied');
  });

  it('resolves timeout after timeout period', async () => {
    vi.useFakeTimers();
    const promise = engine.request({ agentId: 'agent1', tool: 'github/create_pr', args: {} });
    vi.advanceTimersByTime(6000);
    const result = await promise;
    expect(result).toBe('timeout');
    vi.useRealTimers();
  });

  it('getPending() returns pending requests', async () => {
    void engine.request({ agentId: 'agent1', tool: 'github/create_pr', args: { repo: 'test' } });
    const pending = engine.getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].agentId).toBe('agent1');
    expect(pending[0].tool).toBe('github/create_pr');
  });

  it('removes from pending after resolve', async () => {
    const promise = engine.request({ agentId: 'agent1', tool: 'github/create_pr', args: {} });
    const call = (auditLogger.insertHitl as ReturnType<typeof vi.fn>).mock.calls[0][0];
    engine.approve(call.id); // approve by id
    await promise;
    expect(engine.getPending()).toHaveLength(0);
  });
});

describe('HitlBatcher', () => {
  it('fires callback after window', async () => {
    vi.useFakeTimers();
    const batcher = new HitlBatcher(1000);
    const cb = vi.fn();
    batcher.onBatchReady(cb);

    batcher.add({ id: '1', code: 'A1B2C3', agentId: 'agent1', tool: 'foo', args: {}, timeoutMs: 5000 });
    batcher.add({ id: '2', code: 'D4E5F6', agentId: 'agent1', tool: 'bar', args: {}, timeoutMs: 5000 });

    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1100);
    expect(cb).toHaveBeenCalledOnce();
    expect(cb.mock.calls[0][1]).toHaveLength(2);
    vi.useRealTimers();
  });

  it('separate batches per agent', async () => {
    vi.useFakeTimers();
    const batcher = new HitlBatcher(1000);
    const cb = vi.fn();
    batcher.onBatchReady(cb);

    batcher.add({ id: '1', code: 'A1B2C3', agentId: 'agent1', tool: 'foo', args: {}, timeoutMs: 5000 });
    batcher.add({ id: '2', code: 'D4E5F6', agentId: 'agent2', tool: 'bar', args: {}, timeoutMs: 5000 });

    vi.advanceTimersByTime(1100);
    expect(cb).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
