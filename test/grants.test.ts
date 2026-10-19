import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AuditLogger } from '../src/audit/logger.js';
import { HitlEngine, GrantSpecError } from '../src/hitl/engine.js';
import {
  GrantStore,
  canonicalJson,
  fingerprintCall,
  tierFromAnnotations,
  type ApprovalSubject,
} from '../src/hitl/grants.js';
import { registerGrantRoutes } from '../src/hitl/grant-api.js';
import { parseApprovalCommand } from '../src/hitl/parser.js';
import { formatBatch } from '../src/hitl/formatter.js';
import { hitlGateMiddleware } from '../src/middleware/core/hitl-gate.js';
import { AirlockBackendAdapter } from '../src/backend/airlock-adapter.js';
import { HitlBatcher } from '../src/hitl/batcher.js';
import { wireBatcher } from '../src/hitl/runtime.js';
import type { ToolCallContext, ToolCallResponse } from '../src/middleware/types.js';
import type { AgentConfig } from '../src/config/schema.js';

function makeAuditLogger() {
  return {
    insertHitl: vi.fn(),
    updateHitlStatus: vi.fn(),
    getHitlById: vi.fn(),
    getPendingHitl: vi.fn().mockReturnValue([]),
    log: vi.fn(),
  } as unknown as AuditLogger;
}

function makeProvider() {
  return {
    init: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn().mockResolvedValue(undefined),
    updateApprovalStatus: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

function subject(overrides: Partial<ApprovalSubject> = {}): ApprovalSubject {
  const tool = overrides.tool ?? 'gmail/read_email';
  return {
    agentId: 'agent1',
    tool,
    fingerprint: fingerprintCall(tool, { id: '1' }),
    provider: tool.split('/')[0],
    tier: 'read',
    escalated: false,
    ...overrides,
  };
}

function createCall(engine: HitlEngine, s: ApprovalSubject, mode: 'sync' | 'async' = 'sync') {
  return engine.create({
    agentId: s.agentId,
    tool: s.tool,
    args: {},
    kind: 'call',
    mode,
    subject: s,
  });
}

describe('fingerprints and tiers', () => {
  it('canonicalizes key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [1, { y: 1, x: 2 }] } })).toBe(
      canonicalJson({ a: { c: [1, { x: 2, y: 1 }], d: 2 }, b: 1 })
    );
    expect(fingerprintCall('t/x', { a: 1, b: 2 })).toBe(fingerprintCall('t/x', { b: 2, a: 1 }));
    expect(fingerprintCall('t/x', { a: 1 })).not.toBe(fingerprintCall('t/y', { a: 1 }));
  });

  it('follows MCP annotation defaults conservatively', () => {
    expect(tierFromAnnotations({ readOnlyHint: true })).toBe('read');
    expect(tierFromAnnotations({ destructiveHint: false })).toBe('write');
    expect(tierFromAnnotations({})).toBe('destructive');
    expect(tierFromAnnotations(undefined)).toBe('destructive');
  });
});

describe('GrantStore', () => {
  const future = () => new Date(Date.now() + 60_000).toISOString();

  it('matches tool, tier, provider and call scopes', () => {
    const store = new GrantStore(undefined);
    store.create({
      agentId: 'agent1',
      scope: { kind: 'tool', tool: 'gmail/read_email' },
      source: 'operator',
      expiresAt: future(),
    });
    expect(store.find(subject())).toBeDefined();
    expect(store.find(subject({ tool: 'gmail/send_email' }))).toBeUndefined();
    expect(store.find(subject({ agentId: 'other' }))).toBeUndefined();

    const tiers = new GrantStore(undefined);
    tiers.create({
      agentId: 'agent1',
      scope: { kind: 'tier', tier: 'read', provider: 'gmail' },
      source: 'operator',
      expiresAt: future(),
    });
    expect(tiers.find(subject({ tool: 'gmail/list_threads', tier: 'read' }))).toBeDefined();
    expect(tiers.find(subject({ tool: 'gmail/send_email', tier: 'write' }))).toBeUndefined();
    expect(tiers.find(subject({ tool: 'drive/list', tier: 'read' }))).toBeUndefined();

    const writes = new GrantStore(undefined);
    writes.create({
      agentId: 'agent1',
      scope: { kind: 'tier', tier: 'write' },
      source: 'operator',
      expiresAt: future(),
    });
    expect(writes.find(subject({ tool: 'drive/update', tier: 'write' }))).toBeDefined();
    expect(writes.find(subject({ tool: 'drive/delete', tier: 'destructive' }))).toBeUndefined();
  });

  it('never lets a broad grant cover an escalated call, but an exact call grant does', () => {
    const store = new GrantStore(undefined);
    store.create({
      agentId: 'agent1',
      scope: { kind: 'provider', provider: 'gmail' },
      source: 'operator',
      expiresAt: future(),
    });
    expect(store.find(subject({ escalated: true }))).toBeUndefined();

    const s = subject({ escalated: true });
    store.create({
      agentId: 'agent1',
      scope: { kind: 'call', tool: s.tool, fingerprint: s.fingerprint },
      source: 'plan',
      usesRemaining: 1,
    });
    expect(store.find(s)?.scope.kind).toBe('call');
  });

  it('prefers the exact call grant and consumes uses', () => {
    const store = new GrantStore(undefined);
    const s = subject();
    store.create({
      agentId: 'agent1',
      scope: { kind: 'tool', tool: s.tool },
      source: 'operator',
      expiresAt: future(),
      usesRemaining: 5,
    });
    store.create({
      agentId: 'agent1',
      scope: { kind: 'call', tool: s.tool, fingerprint: s.fingerprint },
      source: 'plan',
      usesRemaining: 1,
    });
    expect(store.consume(s)?.scope.kind).toBe('call');
    expect(store.consume(s)?.scope.kind).toBe('tool');
    expect(store.list('agent1')).toHaveLength(1);
    expect(store.list('agent1')[0].usesRemaining).toBe(4);
  });

  it('expires grants and binds session-only grants to their session', () => {
    let now = Date.now();
    const store = new GrantStore(undefined, { now: () => now });
    store.create({
      agentId: 'agent1',
      sessionId: 'session-a',
      scope: { kind: 'tool', tool: 'gmail/read_email' },
      source: 'approval',
      expiresAt: new Date(now + 1000).toISOString(),
    });
    expect(store.find(subject({ sessionId: 'session-a' }))).toBeDefined();
    expect(store.find(subject({ sessionId: 'session-b' }))).toBeUndefined();
    now += 2000;
    expect(store.find(subject({ sessionId: 'session-a' }))).toBeUndefined();
    expect(store.list()).toHaveLength(0);
  });

  it('matches profile scopes through the resolver', () => {
    const store = new GrantStore(undefined, {
      profileCovers: (profile, tool) => profile === 'email-reader' && tool.startsWith('gmail/'),
    });
    store.create({
      agentId: 'agent1',
      scope: { kind: 'profile', profile: 'email-reader' },
      source: 'operator',
      expiresAt: future(),
    });
    expect(store.find(subject())).toBeDefined();
    expect(store.find(subject({ tool: 'drive/list' }))).toBeUndefined();
  });

  describe('persistence', () => {
    let dir: string;
    let auditLogger: AuditLogger;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'airlock-grants-test-'));
      auditLogger = new AuditLogger({
        db_path: join(dir, 'audit.db'),
        retention_days: 90,
        redact_fields: [],
      });
    });
    afterEach(() => {
      auditLogger.stop();
      rmSync(dir, { recursive: true, force: true });
    });

    it('reloads active grants and drops revoked or used-up ones', () => {
      const store = new GrantStore(auditLogger);
      const kept = store.create({
        agentId: 'agent1',
        scope: { kind: 'tool', tool: 'gmail/read_email' },
        source: 'operator',
        expiresAt: future(),
        usesRemaining: 3,
      });
      const revoked = store.create({
        agentId: 'agent1',
        scope: { kind: 'provider', provider: 'drive' },
        source: 'operator',
        expiresAt: future(),
      });
      const usedUp = store.create({
        agentId: 'agent1',
        scope: { kind: 'call', tool: 'x/y', fingerprint: 'f' },
        source: 'plan',
        usesRemaining: 1,
      });
      store.revoke(revoked.id);
      store.consume(subject());
      store.consume(subject({ tool: 'x/y', fingerprint: 'f' }));

      const reloaded = new GrantStore(auditLogger);
      reloaded.load();
      const grants = reloaded.list();
      expect(grants.map((g) => g.id)).toEqual([kept.id]);
      expect(grants[0].usesRemaining).toBe(2);
      expect(usedUp.id).not.toBe(kept.id);
    });
  });
});

describe('HitlEngine grants and batches', () => {
  let engine: HitlEngine;
  let provider: ReturnType<typeof makeProvider>;

  beforeEach(() => {
    provider = makeProvider();
    engine = new HitlEngine(makeAuditLogger(), provider, 60_000, {
      profilesForTool: (tool) => (tool.startsWith('gmail/') ? ['email-reader'] : []),
    });
  });

  it('approving with a tool grant also resolves matching pending calls and future ones', async () => {
    const first = createCall(engine, subject({ fingerprint: 'a' }));
    const second = createCall(engine, subject({ fingerprint: 'b' }));
    const other = createCall(
      engine,
      subject({ tool: 'gmail/send_email', tier: 'write', fingerprint: 'c' })
    );

    const outcome = engine.approve(first.id, { grant: { scope: 'tool', durationMs: 60_000 } });
    expect(outcome?.approved).toEqual([first.id, second.id]);
    expect(await first.result).toBe('approved');
    expect(await second.result).toBe('approved');
    expect(engine.hasPending(other.id)).toBe(true);
    expect(engine.consumeGrant(subject({ fingerprint: 'd' }))).toBeDefined();
  });

  it('caps grant duration and rejects widening a flagged call', () => {
    const flagged = createCall(engine, subject({ escalated: true }));
    expect(() => engine.approve(flagged.id, { grant: { scope: 'tool' } })).toThrow(GrantSpecError);
    expect(engine.hasPending(flagged.id)).toBe(true);

    const normal = createCall(engine, subject({ fingerprint: 'z' }));
    const outcome = engine.approve(normal.id, {
      grant: { scope: 'provider', durationMs: 365 * 86_400_000 },
    });
    const expiresIn = Date.parse(outcome!.grant!.expiresAt!) - Date.now();
    expect(expiresIn).toBeLessThanOrEqual(24 * 60 * 60_000);
  });

  it('validates profile grants against the profiles covering the tool', () => {
    const req = createCall(engine, subject());
    expect(() => engine.approve(req.id, { grant: { scope: 'profile', profile: 'nope' } })).toThrow(
      GrantSpecError
    );
    const outcome = engine.approve(req.id, {
      grant: { scope: 'profile', profile: 'email-reader' },
    });
    expect(outcome?.grant?.scope).toEqual({ kind: 'profile', profile: 'email-reader' });
  });

  it('offers grant options matching the request tier and profiles', () => {
    createCall(engine, subject());
    const [pending] = engine.getPending();
    expect(pending.grantOptions?.map((o) => o.scope)).toEqual([
      'tool',
      'tier',
      'provider',
      'profile',
    ]);
    expect(pending.grantOptions?.[1]).toMatchObject({ tier: 'read' });
  });

  it('approves a batch by code, skipping flagged members, and only what was snapshotted', async () => {
    const a = createCall(engine, subject({ fingerprint: '1' }));
    const b = createCall(engine, subject({ fingerprint: '2' }));
    const flagged = createCall(engine, subject({ fingerprint: '3', escalated: true }));
    const batch = engine.registerBatch([a.id, b.id, flagged.id])!;
    const late = createCall(engine, subject({ fingerprint: '4' }));

    engine.approveByCode(batch.batchCode);
    expect(await a.result).toBe('approved');
    expect(await b.result).toBe('approved');
    expect(engine.hasPending(flagged.id)).toBe(true);
    expect(engine.hasPending(late.id)).toBe(true);

    engine.denyByCode(batch.batchCode, 'no');
    expect(await flagged.result).toBe('denied');
    expect(engine.hasBatch(batch.batchCode)).toBe(false);
    const lastStatus = provider.updateApprovalStatus.mock.calls.at(-1)?.[0];
    expect(lastStatus).toMatchObject({ batchId: batch.batchId, batchPending: 0 });
  });

  it('does not create a batch for a single request', () => {
    const a = createCall(engine, subject());
    expect(engine.registerBatch([a.id])).toBeUndefined();
  });

  it('async approval leaves a single-use grant for the exact retry', () => {
    const s = subject();
    const ticket = createCall(engine, s, 'async');
    expect(engine.findPendingCall('agent1', s.fingerprint)?.id).toBe(ticket.id);
    engine.approve(ticket.id);
    expect(engine.consumeGrant({ ...s, fingerprint: 'different' })).toBeUndefined();
    expect(engine.consumeGrant(s)?.source).toBe('async');
    expect(engine.consumeGrant(s)).toBeUndefined();
  });

  it('remembers async denials so retries do not re-prompt', () => {
    const s = subject();
    const ticket = createCall(engine, s, 'async');
    engine.deny(ticket.id, 'no');
    expect(engine.wasRecentlyDenied('agent1', s.fingerprint)).toBe(true);
    expect(engine.wasRecentlyDenied('agent2', s.fingerprint)).toBe(false);
  });

  it('plan approval creates one call grant per planned call', () => {
    const fp = (id: string) => fingerprintCall('gmail/read_email', { id });
    const ticket = engine.create({
      agentId: 'agent1',
      tool: 'airlock/request_approval',
      args: {},
      kind: 'plan',
      plan: [
        { tool: 'gmail/read_email', fingerprint: fp('1'), args: { id: '1' } },
        { tool: 'gmail/read_email', fingerprint: fp('2'), args: { id: '2' } },
        { tool: 'gmail/read_email', fingerprint: fp('2'), args: { id: '2' } },
      ],
    });
    engine.approve(ticket.id);
    const s = (id: string) => subject({ fingerprint: fp(id), escalated: true });
    expect(engine.consumeGrant(s('1'))).toBeDefined();
    expect(engine.consumeGrant(s('1'))).toBeUndefined();
    expect(engine.consumeGrant(s('2'))).toBeDefined();
    expect(engine.consumeGrant(s('2'))).toBeDefined();
    expect(engine.consumeGrant(s('2'))).toBeUndefined();
    expect(engine.consumeGrant(s('3'))).toBeUndefined();
  });

  it('waitFor returns pending, then the decision, and hides other agents approvals', async () => {
    const ticket = createCall(engine, subject());
    expect((await engine.waitFor(ticket.id, 'agent1', 10))?.status).toBe('pending');
    expect(await engine.waitFor(ticket.id, 'intruder', 10)).toBeUndefined();
    setTimeout(() => engine.approve(ticket.id), 5);
    const auditLogger = (
      engine as unknown as { auditLogger: { getHitlById: ReturnType<typeof vi.fn> } }
    ).auditLogger;
    auditLogger.getHitlById.mockReturnValue({
      id: ticket.id,
      code: ticket.code,
      agent_id: 'agent1',
      tool: 'gmail/read_email',
      status: 'approved',
    });
    expect((await engine.waitFor(ticket.id, 'agent1', 1000))?.status).toBe('approved');
  });

  it('wires batches through the batcher with a shared batch code', async () => {
    const batcher = new HitlBatcher(0);
    wireBatcher(batcher, engine, provider);
    const a = createCall(engine, subject({ fingerprint: '1' }));
    const b = createCall(engine, subject({ fingerprint: '2' }));
    batcher.add(engine.buildNotification(a.id)!);
    batcher.add(engine.buildNotification(b.id)!);
    await vi.waitFor(() => expect(provider.notify).toHaveBeenCalled());
    const notified = provider.notify.mock.calls[0][0];
    expect(notified).toHaveLength(2);
    expect(notified[0].batchCode).toBeDefined();
    expect(notified[0].batchCode).toBe(notified[1].batchCode);
    expect(formatBatch(notified)).toContain(`approve all ${notified[0].batchCode}`);
  });
});

describe('parseApprovalCommand grants and batches', () => {
  it('parses approve all and grant durations/scopes', () => {
    expect(parseApprovalCommand('approve all ABC12345')).toEqual({
      type: 'approve',
      code: 'ABC12345',
    });
    expect(parseApprovalCommand('approve ABC123 15m')).toEqual({
      type: 'approve',
      code: 'ABC123',
      grant: { scope: 'tool', durationMs: 900_000 },
    });
    expect(parseApprovalCommand('approve ABC123 for 2h reads')).toEqual({
      type: 'approve',
      code: 'ABC123',
      grant: { scope: 'tier', tier: 'read', durationMs: 7_200_000 },
    });
    expect(parseApprovalCommand('approve ABC123 provider')).toEqual({
      type: 'approve',
      code: 'ABC123',
      grant: { scope: 'provider' },
    });
    expect(parseApprovalCommand('deny all ABC123 not now')).toEqual({
      type: 'deny',
      code: 'ABC123',
      reason: 'not now',
    });
    expect(parseApprovalCommand('approve ABC123 whatever')).toBeNull();
  });
});

describe('hitl gate with grants and async mode', () => {
  const okResponse: ToolCallResponse = { result: 'ok', text: 'ok' };

  function makeCtx(engine: HitlEngine, agentConfig: Partial<AgentConfig> = {}): ToolCallContext {
    return {
      callId: 'call',
      agentId: 'agent1',
      agentConfig: {
        allow: [],
        ask: [],
        deny: [],
        tool_overrides: {},
        ...agentConfig,
      } as AgentConfig,
      toolName: 'gmail/read_email',
      args: { id: '42' },
      meta: { needsApproval: true, downstreamSessionId: 's1' },
      deps: {
        registry: { toolTier: () => 'read' } as any,
        allowlist: {} as any,
        hitlEngine: engine,
        hitlBatcher: { add: vi.fn() } as any,
        auditLogger: { log: vi.fn() } as any,
        securityConfig: { blocked_hosts: [], allowed_local: [] },
      },
      startedAt: Date.now(),
    };
  }

  it('lets a covered call through without creating an approval', async () => {
    const engine = new HitlEngine(makeAuditLogger(), makeProvider(), 60_000);
    engine.createOperatorGrant({
      agentId: 'agent1',
      scope: { kind: 'tier', tier: 'read', provider: 'gmail' },
    });
    const next = vi.fn().mockResolvedValue(okResponse);
    const ctx = makeCtx(engine);
    await expect(hitlGateMiddleware()(ctx, next)).resolves.toBe(okResponse);
    expect(engine.getPending()).toHaveLength(0);
    expect(ctx.deps.auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'hitl_granted' })
    );
  });

  it('async mode returns pending at once, dedupes retries, and runs the retry after approval', async () => {
    const engine = new HitlEngine(makeAuditLogger(), makeProvider(), 60_000, {
      defaultMode: 'async',
    });
    const next = vi.fn().mockResolvedValue(okResponse);

    const first = await hitlGateMiddleware()(makeCtx(engine), next);
    expect(first.text).toMatch(/^Approval pending/);
    expect(next).not.toHaveBeenCalled();
    expect(engine.getPending()).toHaveLength(1);

    const retry = await hitlGateMiddleware()(makeCtx(engine), next);
    expect(retry.text).toMatch(/^Approval pending/);
    expect(engine.getPending()).toHaveLength(1);

    engine.approve(engine.getPending()[0].id);
    await expect(hitlGateMiddleware()(makeCtx(engine), next)).resolves.toBe(okResponse);

    // The single-use grant is spent: the next identical call asks again.
    const again = await hitlGateMiddleware()(makeCtx(engine), next);
    expect(again.text).toMatch(/^Approval pending/);
  });

  it('per-agent approval_mode overrides the default', async () => {
    const engine = new HitlEngine(makeAuditLogger(), makeProvider(), 60_000, {
      defaultMode: 'sync',
    });
    const response = await hitlGateMiddleware()(
      makeCtx(engine, { approval_mode: 'async' }),
      vi.fn()
    );
    expect(response.text).toMatch(/^Approval pending/);
  });

  it('sends progress while a sync call waits', async () => {
    vi.useFakeTimers();
    try {
      const engine = new HitlEngine(makeAuditLogger(), makeProvider(), 0);
      const ctx = makeCtx(engine);
      ctx.sendProgress = vi.fn();
      const pending = hitlGateMiddleware()(ctx, vi.fn().mockResolvedValue(okResponse));
      await vi.advanceTimersByTimeAsync(31_000);
      expect(ctx.sendProgress).toHaveBeenCalledTimes(2);
      engine.approve(engine.getPending()[0].id);
      await pending;
      await vi.advanceTimersByTimeAsync(31_000);
      expect(ctx.sendProgress).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('airlock approval tools', () => {
  function makeAdapter(engine: HitlEngine, mode?: 'async') {
    return new AirlockBackendAdapter({
      hitlEngine: engine,
      hitlBatcher: { add: vi.fn() } as any,
      getAgentConfig: () => ({ approval_mode: mode }) as AgentConfig,
      getAgentTools: () => [
        {
          tool: { name: 'gmail/read_email', inputSchema: { type: 'object' } },
          decision: 'ask',
          providerId: 'gmail',
          resolvedName: 'gmail/read_email',
        },
        {
          tool: { name: 'gmail/list', inputSchema: { type: 'object' } },
          decision: 'allow',
          providerId: 'gmail',
          resolvedName: 'gmail/list',
        },
      ],
    });
  }

  it('request_approval approves a plan whose calls then pass the gate', async () => {
    const engine = new HitlEngine(makeAuditLogger(), makeProvider(), 60_000);
    const adapter = makeAdapter(engine);
    const resultPromise = adapter.call({
      tool: 'airlock/request_approval',
      agentId: 'agent1',
      args: {
        reason: 'Summarize inbox',
        calls: [
          { tool: 'gmail_read_email', arguments: { id: '1' } },
          { tool: 'gmail_read_email', arguments: { id: '2', _airlock: { reason: 'x' } } },
          { tool: 'gmail/list', arguments: {} },
        ],
      },
    });
    await vi.waitFor(() => expect(engine.getPending()).toHaveLength(1));
    const [pending] = engine.getPending();
    expect(pending.kind).toBe('plan');
    expect(pending.plan).toHaveLength(2);
    engine.approve(pending.id);
    const result = await resultPromise;
    expect(result.data).toMatchObject({
      status: 'approved',
      calls: 2,
      notRequired: ['gmail/list'],
    });

    const s = (id: string) => subject({ fingerprint: fingerprintCall('gmail/read_email', { id }) });
    expect(engine.consumeGrant(s('1'))).toBeDefined();
    expect(engine.consumeGrant(s('2'))).toBeDefined();
    expect(engine.consumeGrant(s('3'))).toBeUndefined();
  });

  it('request_approval rejects tools the agent cannot use', async () => {
    const engine = new HitlEngine(makeAuditLogger(), makeProvider(), 60_000);
    const result = await makeAdapter(engine).call({
      tool: 'airlock/request_approval',
      agentId: 'agent1',
      args: { reason: 'x', calls: [{ tool: 'shell/rm', arguments: {} }] },
    });
    expect(result.success).toBe(false);
    expect(engine.getPending()).toHaveLength(0);
  });

  it('async plans return an id that await_approval resolves', async () => {
    const auditLogger = makeAuditLogger();
    const engine = new HitlEngine(auditLogger, makeProvider(), 60_000);
    const adapter = makeAdapter(engine, 'async');
    const requested = await adapter.call({
      tool: 'airlock/request_approval',
      agentId: 'agent1',
      args: { reason: 'x', calls: [{ tool: 'gmail/read_email', arguments: { id: '1' } }] },
    });
    const { id, status } = requested.data as { id: string; status: string };
    expect(status).toBe('pending');

    const waiting = await adapter.call({
      tool: 'airlock/await_approval',
      agentId: 'agent1',
      args: { id, wait_seconds: 0 },
    });
    expect(waiting.data).toMatchObject({ status: 'pending' });

    engine.approve(id);
    (auditLogger.getHitlById as ReturnType<typeof vi.fn>).mockReturnValue({
      id,
      code: 'X',
      agent_id: 'agent1',
      tool: 'airlock/request_approval',
      status: 'approved',
      meta: JSON.stringify({ kind: 'plan' }),
    });
    const done = await adapter.call({
      tool: 'airlock/await_approval',
      agentId: 'agent1',
      args: { id },
    });
    expect(done.data).toMatchObject({ status: 'approved' });
    expect((done.data as { message: string }).message).toMatch(/listed call/);

    const foreign = await adapter.call({
      tool: 'airlock/await_approval',
      agentId: 'agent2',
      args: { id },
    });
    expect(foreign.success).toBe(false);
  });
});

describe('grant routes', () => {
  let app: FastifyInstance;
  let engine: HitlEngine;

  beforeEach(async () => {
    engine = new HitlEngine(makeAuditLogger(), makeProvider(), 60_000);
    app = Fastify({ logger: false });
    registerGrantRoutes(app, engine, '/hitl');
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  it('creates, lists and revokes operator grants', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/hitl/grants',
      payload: {
        agent: 'agent1',
        scope: { kind: 'tier', tier: 'read', provider: 'gmail' },
        duration_ms: 600_000,
      },
    });
    expect(created.statusCode).toBe(200);
    const { grant } = created.json() as { grant: { id: string; label: string } };
    expect(grant.label).toContain('read-only tools from gmail');

    const listed = await app.inject({ method: 'GET', url: '/hitl/grants?agent=agent1' });
    expect((listed.json() as { grants: unknown[] }).grants).toHaveLength(1);

    const bad = await app.inject({
      method: 'POST',
      url: '/hitl/grants',
      payload: { agent: 'agent1', scope: { kind: 'call' } },
    });
    expect(bad.statusCode).toBe(400);

    expect(
      (await app.inject({ method: 'DELETE', url: `/hitl/grants/${grant.id}` })).statusCode
    ).toBe(200);
    expect(
      (await app.inject({ method: 'DELETE', url: `/hitl/grants/${grant.id}` })).statusCode
    ).toBe(404);
  });

  it('decides an explicit list of approvals in bulk', async () => {
    const a = createCall(engine, subject({ fingerprint: '1' }));
    const flagged = createCall(engine, subject({ fingerprint: '2', escalated: true }));
    const response = await app.inject({
      method: 'POST',
      url: '/hitl/approvals/decisions',
      payload: { ids: [a.id, flagged.id, 'missing'], decision: 'approved' },
    });
    expect(response.json()).toEqual({
      ok: true,
      approved: [a.id],
      skipped: [flagged.id, 'missing'],
    });
    expect(engine.hasPending(flagged.id)).toBe(true);
  });

  it('decides a batch by code', async () => {
    const a = createCall(engine, subject({ fingerprint: '1' }));
    const b = createCall(engine, subject({ fingerprint: '2' }));
    const batch = engine.registerBatch([a.id, b.id])!;
    const response = await app.inject({
      method: 'POST',
      url: `/hitl/batches/${batch.batchCode}/decision`,
      payload: { decision: 'denied' },
    });
    expect((response.json() as { denied: string[] }).denied).toEqual([a.id, b.id]);
    const missing = await app.inject({
      method: 'POST',
      url: `/hitl/batches/${batch.batchCode}/decision`,
      payload: { decision: 'denied' },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe('review regressions', () => {
  let engine: HitlEngine;

  beforeEach(() => {
    engine = new HitlEngine(makeAuditLogger(), makeProvider(), 60_000);
  });

  it('approve all never approves plans or questions in the batch', async () => {
    const call = createCall(engine, subject({ fingerprint: '1' }));
    const plan = engine.create({
      agentId: 'agent1',
      tool: 'airlock/request_approval',
      args: {},
      kind: 'plan',
      plan: [{ tool: 'x/exfil', fingerprint: 'f', args: {} }],
    });
    const question = engine.create({
      agentId: 'agent1',
      tool: 'airlock/ask_user',
      args: { question: 'wire $1M?' },
      kind: 'question',
    });
    const batch = engine.registerBatch([call.id, plan.id, question.id])!;
    const outcome = engine.approveBatch(batch.batchCode);
    expect(outcome?.approved).toEqual([call.id]);
    expect(outcome?.skipped).toEqual([plan.id, question.id]);
    expect(engine.consumeGrant(subject({ tool: 'x/exfil', fingerprint: 'f' }))).toBeUndefined();
  });

  it('maxUses counts the approving request and every auto-approved one, sync or async', () => {
    const first = createCall(engine, subject({ fingerprint: '0' }));
    const others = ['1', '2', '3'].map((fp) =>
      createCall(engine, subject({ fingerprint: fp }), 'async')
    );
    const outcome = engine.approve(first.id, { grant: { scope: 'tool', maxUses: 2 } });
    expect(outcome?.approved).toEqual([first.id, others[0].id]);
    expect(engine.hasPending(others[1].id)).toBe(true);
    expect(engine.listGrants('agent1').filter((g) => g.source === 'approval')).toHaveLength(0);

    const single = createCall(engine, subject({ fingerprint: '9' }));
    expect(
      engine.approve(single.id, { grant: { scope: 'tool', maxUses: 1 } })?.grant
    ).toBeUndefined();
  });

  it('rejects fractional or zero maxUses instead of granting unlimited use', () => {
    const req = createCall(engine, subject());
    expect(() => engine.approve(req.id, { grant: { scope: 'tool', maxUses: 0.5 } })).toThrow(
      GrantSpecError
    );
    expect(() =>
      engine.createOperatorGrant({
        agentId: 'agent1',
        scope: { kind: 'tool', tool: 't/x' },
        maxUses: 0,
      })
    ).toThrow(GrantSpecError);
  });

  it('refuses a session-only grant for a request without a session', () => {
    const req = createCall(engine, subject({ sessionId: undefined }));
    expect(() => engine.approve(req.id, { grant: { scope: 'tool', sessionOnly: true } })).toThrow(
      GrantSpecError
    );
    expect(engine.hasPending(req.id)).toBe(true);
  });

  it('refuses to attach a grant to a batch code', () => {
    const a = createCall(engine, subject({ fingerprint: '1' }));
    const b = createCall(engine, subject({ fingerprint: '2' }));
    const batch = engine.registerBatch([a.id, b.id])!;
    expect(() => engine.approveByCode(batch.batchCode, { grant: { scope: 'tool' } })).toThrow(
      GrantSpecError
    );
    expect(engine.hasPending(a.id)).toBe(true);
  });

  describe('grants shared across processes', () => {
    let dir: string;
    let loggerA: AuditLogger;
    let loggerB: AuditLogger;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'airlock-grants-shared-'));
      const config = { db_path: join(dir, 'audit.db'), retention_days: 90, redact_fields: [] };
      loggerA = new AuditLogger(config);
      loggerB = new AuditLogger(config);
    });
    afterEach(() => {
      loggerA.stop();
      loggerB.stop();
      rmSync(dir, { recursive: true, force: true });
    });

    it('spends a single-use grant once and honours revokes from another process', () => {
      const a = new GrantStore(loggerA);
      const b = new GrantStore(loggerB);
      const s = subject();
      a.create({
        agentId: 'agent1',
        scope: { kind: 'call', tool: s.tool, fingerprint: s.fingerprint },
        source: 'plan',
        usesRemaining: 1,
      });
      const broad = a.create({
        agentId: 'agent1',
        scope: { kind: 'provider', provider: 'gmail' },
        source: 'operator',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      b.load();

      expect(a.consume(s)?.scope.kind).toBe('call');
      // B still has the call grant cached, but the DB says it's spent; it falls back to the broad one.
      expect(b.consume(s)?.scope.kind).toBe('provider');

      expect(b.revoke(broad.id)).toBe(true);
      expect(a.consume(s)).toBeUndefined();
    });

    it('picks up grants created by another process', () => {
      const a = new GrantStore(loggerA);
      const b = new GrantStore(loggerB);
      a.create({
        agentId: 'agent1',
        scope: { kind: 'tool', tool: 'gmail/read_email' },
        source: 'operator',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      expect(b.consume(subject())).toBeDefined();
    });
  });

  it('exposes only approval tools when the airlock builtin is not configured', async () => {
    const adapter = new AirlockBackendAdapter({}, true);
    expect((await adapter.listTools()).map((t) => t.name)).toEqual([
      'airlock/request_approval',
      'airlock/await_approval',
    ]);
    const result = await adapter.call({
      tool: 'airlock/notify_user',
      agentId: 'a',
      args: { title: 't', body: 'b' },
    });
    expect(result.success).toBe(false);
  });
});
