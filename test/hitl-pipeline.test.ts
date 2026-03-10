import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HitlEngine } from '../src/hitl/engine.js';
import { HitlBatcher } from '../src/hitl/batcher.js';
import type { AuditLogger } from '../src/audit/logger.js';
import type { HitlNotification } from '../src/hitl/providers/types.js';

function makeMockAuditLogger() {
  return {
    insertHitl: vi.fn(),
    updateHitlStatus: vi.fn(),
    getPendingHitl: vi.fn().mockReturnValue([]),
    log: vi.fn(),
  } as unknown as AuditLogger;
}

function makeMockProvider() {
  return {
    init: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

describe('HitlEngine.create() returns id and code synchronously', () => {
  it('returns {id, code, result} — not a bare Promise', () => {
    const auditLogger = makeMockAuditLogger();
    const provider = makeMockProvider();
    const engine = new HitlEngine(auditLogger, provider, 5000);

    const ticket = engine.create({ agentId: 'agent1', tool: 'github/create_pr', args: {} });

    expect(ticket).toHaveProperty('id');
    expect(ticket).toHaveProperty('code');
    expect(ticket).toHaveProperty('result');
    expect(typeof ticket.id).toBe('string');
    expect(typeof ticket.code).toBe('string');
    expect(ticket.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(ticket.result).toBeInstanceOf(Promise);
  });

  it('code in ticket matches code persisted to DB', () => {
    const auditLogger = makeMockAuditLogger();
    const provider = makeMockProvider();
    const engine = new HitlEngine(auditLogger, provider, 5000);

    const ticket = engine.create({ agentId: 'agent1', tool: 'github/create_pr', args: {} });

    const dbCall = (auditLogger.insertHitl as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(ticket.code).toBe(dbCall.code);
    expect(ticket.id).toBe(dbCall.id);
  });

  it('result promise resolves approved when approve(code) called', async () => {
    const auditLogger = makeMockAuditLogger();
    const provider = makeMockProvider();
    const engine = new HitlEngine(auditLogger, provider, 5000);

    const { code, result } = engine.create({ agentId: 'agent1', tool: 'github/create_pr', args: {} });
    engine.approve(code);
    expect(await result).toBe('approved');
  });

  it('result promise resolves denied when deny(code) called', async () => {
    const auditLogger = makeMockAuditLogger();
    const provider = makeMockProvider();
    const engine = new HitlEngine(auditLogger, provider, 5000);

    const { code, result } = engine.create({ agentId: 'agent1', tool: 'github/create_pr', args: {} });
    engine.deny(code, 'not now');
    expect(await result).toBe('denied');
  });

  it('result promise resolves timeout after timeout period', async () => {
    vi.useFakeTimers();
    const auditLogger = makeMockAuditLogger();
    const provider = makeMockProvider();
    const engine = new HitlEngine(auditLogger, provider, 5000);

    const { result } = engine.create({ agentId: 'agent1', tool: 'github/create_pr', args: {} });
    vi.advanceTimersByTime(6000);
    expect(await result).toBe('timeout');
    vi.useRealTimers();
  });
});

describe('Batcher receives real id and code from engine', () => {
  it('provider notification contains the real code from engine', async () => {
    vi.useFakeTimers();
    const auditLogger = makeMockAuditLogger();
    const provider = makeMockProvider();
    const engine = new HitlEngine(auditLogger, provider, 30000);
    const batcher = new HitlBatcher(1000);

    const notifications: HitlNotification[] = [];
    batcher.onBatchReady((_agentId, requests) => {
      notifications.push(...requests);
    });

    // Simulate the correct pipeline: engine.create() → batcher.add() with real id/code
    const ticket = engine.create({ agentId: 'agent1', tool: 'github/create_pr', args: { repo: 'test' } });
    batcher.add({
      id: ticket.id,
      code: ticket.code,
      agentId: 'agent1',
      tool: 'github/create_pr',
      args: { repo: 'test' },
      timeoutMs: 30000,
    });

    vi.advanceTimersByTime(1100);

    expect(notifications).toHaveLength(1);
    expect(notifications[0].code).toBe(ticket.code);
    expect(notifications[0].id).toBe(ticket.id);
    expect(notifications[0].code).toMatch(/^[A-Z0-9]{6}$/);

    vi.useRealTimers();
  });

  it('operator can approve using the code from the notification', async () => {
    vi.useFakeTimers();
    const auditLogger = makeMockAuditLogger();
    const provider = makeMockProvider();
    const engine = new HitlEngine(auditLogger, provider, 30000);
    const batcher = new HitlBatcher(500);

    let notifiedCode: string | undefined;
    batcher.onBatchReady((_agentId, requests) => {
      notifiedCode = requests[0].code;
    });

    const ticket = engine.create({ agentId: 'agent1', tool: 'github/create_pr', args: {} });
    batcher.add({ id: ticket.id, code: ticket.code, agentId: 'agent1', tool: 'github/create_pr', args: {}, timeoutMs: 30000 });

    vi.advanceTimersByTime(600);
    expect(notifiedCode).toBe(ticket.code);

    // Operator approves using the code they received
    engine.approve(notifiedCode!);
    expect(await ticket.result).toBe('approved');

    vi.useRealTimers();
  });
});

describe('Backwards compatibility: approve/deny/getPending still work', () => {
  let engine: HitlEngine;

  beforeEach(() => {
    engine = new HitlEngine(makeMockAuditLogger(), makeMockProvider(), 5000);
  });

  it('getPending returns created requests', () => {
    engine.create({ agentId: 'a', tool: 't', args: {} });
    engine.create({ agentId: 'a', tool: 't2', args: {} });
    expect(engine.getPending()).toHaveLength(2);
  });

  it('approve by id works', async () => {
    const { id, result } = engine.create({ agentId: 'a', tool: 't', args: {} });
    engine.approve(id);
    expect(await result).toBe('approved');
  });

  it('pending count drops to 0 after resolve', async () => {
    const { code, result } = engine.create({ agentId: 'a', tool: 't', args: {} });
    engine.approve(code);
    await result;
    expect(engine.getPending()).toHaveLength(0);
  });
});
