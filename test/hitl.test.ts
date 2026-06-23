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
    updateBadge: vi.fn().mockResolvedValue(undefined),
    updateApprovalStatus: vi.fn().mockResolvedValue(undefined),
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
    const { code, result } = engine.create({
      agentId: 'agent1',
      tool: 'github/create_pr',
      args: {},
    });
    engine.approve(code);
    expect(await result).toBe('approved');
  });

  it('resolves denied when deny() called', async () => {
    const { code, result } = engine.create({
      agentId: 'agent1',
      tool: 'github/create_pr',
      args: {},
    });
    engine.deny(code, 'not today');
    expect(await result).toBe('denied');
  });

  it('resolves timeout after timeout period', async () => {
    vi.useFakeTimers();
    const { result } = engine.create({ agentId: 'agent1', tool: 'github/create_pr', args: {} });
    vi.advanceTimersByTime(6000);
    expect(await result).toBe('timeout');
    vi.useRealTimers();
  });

  it('updates badge count when a request times out', async () => {
    vi.useFakeTimers();
    const { result } = engine.create({ agentId: 'agent1', tool: 'github/create_pr', args: {} });
    vi.advanceTimersByTime(6000);
    expect(await result).toBe('timeout');
    expect(provider.updateApprovalStatus).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'timeout', badgeCount: 0 })
    );
    vi.useRealTimers();
  });

  it('getPending() returns pending requests', () => {
    engine.create({ agentId: 'agent1', tool: 'github/create_pr', args: { repo: 'test' } });
    const pending = engine.getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].agentId).toBe('agent1');
    expect(pending[0].tool).toBe('github/create_pr');
  });

  it('redacts approval args before storing and exposing pending requests', () => {
    (auditLogger as any).redactArgs = vi.fn().mockReturnValue({ token: '[REDACTED]', repo: 'test' });
    engine.create({
      agentId: 'agent1',
      tool: 'github/create_pr',
      args: { token: 'secret-token', repo: 'test' },
    });

    expect(auditLogger.insertHitl).toHaveBeenCalledWith(
      expect.objectContaining({
        args: JSON.stringify({ token: '[REDACTED]', repo: 'test' }),
      })
    );
    expect(engine.getPending()[0].args).toEqual({ token: '[REDACTED]', repo: 'test' });
  });

  it('removes from pending after resolve', async () => {
    const { id, result } = engine.create({ agentId: 'agent1', tool: 'github/create_pr', args: {} });
    engine.approve(id);
    await result;
    expect(engine.getPending()).toHaveLength(0);
  });

  it('updates badge count when a request is approved', async () => {
    const { id, result } = engine.create({ agentId: 'agent1', tool: 'github/create_pr', args: {} });
    engine.approve(id);
    await result;
    expect(provider.updateApprovalStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id, result: 'approved', badgeCount: 0 })
    );
  });
});

describe('HitlEngine.cancel()', () => {
  let engine: HitlEngine;
  let auditLogger: ReturnType<typeof makeMockAuditLogger>;

  beforeEach(() => {
    auditLogger = makeMockAuditLogger();
    engine = new HitlEngine(auditLogger, makeMockProvider(), 5000);
  });

  it('resolves cancelled when cancel() called by id', async () => {
    const { id, result } = engine.create({
      agentId: 'agent1',
      tool: 'supabase/execute_sql',
      args: {},
    });
    engine.cancel(id);
    expect(await result).toBe('cancelled');
  });

  it('removes request from pending after cancel', async () => {
    const { id, result } = engine.create({
      agentId: 'agent1',
      tool: 'supabase/execute_sql',
      args: {},
    });
    engine.cancel(id);
    await result;
    expect(engine.getPending()).toHaveLength(0);
  });

  it('updates audit DB status to cancelled', async () => {
    const { id, result } = engine.create({
      agentId: 'agent1',
      tool: 'supabase/execute_sql',
      args: {},
    });
    engine.cancel(id);
    await result;
    expect(auditLogger.updateHitlStatus).toHaveBeenCalledWith(id, 'cancelled');
  });

  it('is a no-op for unknown id', () => {
    expect(() => engine.cancel('nonexistent-id')).not.toThrow();
  });

  it('cancel after approve is a no-op — does not double-resolve', async () => {
    const { id, result } = engine.create({
      agentId: 'agent1',
      tool: 'supabase/execute_sql',
      args: {},
    });
    engine.approve(id);
    engine.cancel(id); // already gone from pending
    expect(await result).toBe('approved');
  });

  it('clears the timeout timer on cancel', async () => {
    vi.useFakeTimers();
    const { id, result } = engine.create({
      agentId: 'agent1',
      tool: 'supabase/execute_sql',
      args: {},
    });
    engine.cancel(id);
    await result;
    // Advancing past the original timeout should not throw or double-resolve
    vi.advanceTimersByTime(10000);
    vi.useRealTimers();
  });
});

describe('HitlBatcher', () => {
  it('fires callback after window', async () => {
    vi.useFakeTimers();
    const batcher = new HitlBatcher(1000);
    const cb = vi.fn();
    batcher.onBatchReady(cb);

    batcher.add({
      id: '1',
      code: 'A1B2C3',
      agentId: 'agent1',
      tool: 'foo',
      args: {},
      timeoutMs: 5000,
    });
    batcher.add({
      id: '2',
      code: 'D4E5F6',
      agentId: 'agent1',
      tool: 'bar',
      args: {},
      timeoutMs: 5000,
    });

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

    batcher.add({
      id: '1',
      code: 'A1B2C3',
      agentId: 'agent1',
      tool: 'foo',
      args: {},
      timeoutMs: 5000,
    });
    batcher.add({
      id: '2',
      code: 'D4E5F6',
      agentId: 'agent2',
      tool: 'bar',
      args: {},
      timeoutMs: 5000,
    });

    vi.advanceTimersByTime(1100);
    expect(cb).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
