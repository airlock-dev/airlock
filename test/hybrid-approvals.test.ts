import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ProtocolError } from '@modelcontextprotocol/server';
import { AuditLogger } from '../src/audit/logger.js';
import { HitlEngine, GrantSpecError } from '../src/hitl/engine.js';
import { DeferredExecutionStore } from '../src/hitl/deferred.js';
import { fingerprintCall } from '../src/hitl/grants.js';
import { hitlApiPlugin } from '../src/hitl/api.js';
import { hitlGateMiddleware } from '../src/middleware/core/hitl-gate.js';
import {
  rateLimiterMiddleware,
  resetRateLimiterState,
} from '../src/middleware/core/rate-limiter.js';
import { markDispatched } from '../src/middleware/core/execute.js';
import { compose } from '../src/middleware/compose.js';
import { AirlockBackendAdapter } from '../src/backend/airlock-adapter.js';
import { AllowlistEngine } from '../src/allowlist/engine.js';
import { EventService, type EventRequestContext } from '../src/events/service.js';
import { EventStreamManager } from '../src/events/stream-manager.js';
import { APPROVAL_DECIDED_EVENT } from '../src/events/approval-events.js';
import { EVENT_NOTIFICATIONS } from '../src/events/protocol.js';
import { connectionClosedReason } from '../src/util/abort.js';
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

const okResponse = (text = 'sent'): ToolCallResponse => ({
  result: { content: [{ type: 'text', text }] },
  text,
});

function makeEngine(options: ConstructorParameters<typeof HitlEngine>[3] = {}) {
  const auditLogger = makeAuditLogger();
  return { engine: new HitlEngine(auditLogger, makeProvider(), 60_000, options), auditLogger };
}

/**
 * A ctx for a gated gmail/send_email call. `reenter` re-runs the gate the way agent-server's real
 * reentry does (fresh context, same args), with `execute` standing in for the downstream.
 */
function makeCtx(
  engine: HitlEngine,
  opts: {
    agentConfig?: Partial<AgentConfig>;
    args?: Record<string, unknown>;
    signal?: AbortSignal;
    execute?: () => Promise<ToolCallResponse>;
    reentry?: boolean;
  } = {}
): ToolCallContext {
  const execute = opts.execute ?? (() => Promise.resolve(okResponse()));
  const ctx: ToolCallContext = {
    callId: 'call-1',
    agentId: 'agent1',
    agentConfig: {
      allow: [],
      ask: ['gmail/*'],
      deny: [],
      tool_overrides: {},
      ...opts.agentConfig,
    } as AgentConfig,
    toolName: 'gmail/send_email',
    args: opts.args ?? { to: 'a@example.com' },
    meta: { policyAsk: true },
    deps: {
      registry: { toolTier: () => 'destructive' } as any,
      allowlist: {} as any,
      hitlEngine: engine,
      hitlBatcher: { add: vi.fn(), remove: vi.fn() } as any,
      auditLogger: { log: vi.fn() } as any,
      securityConfig: { blocked_hosts: [], allowed_local: [] },
    },
    startedAt: Date.now(),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
  if (opts.reentry !== false) {
    ctx.reenter = (prepare) => {
      const fresh: ToolCallContext = { ...ctx, meta: { policyAsk: true }, startedAt: Date.now() };
      delete fresh.signal;
      prepare(fresh);
      return hitlGateMiddleware()(fresh, execute);
    };
  }
  return ctx;
}

const payloadOf = (response: ToolCallResponse) =>
  JSON.parse(response.text) as Record<string, unknown>;

afterEach(() => {
  vi.useRealTimers();
});

// ─── Pillar 1: wait-then-spill ────────────────────────────────────────────────

describe('hybrid approvals (wait-then-spill)', () => {
  it('defaults to hybrid with a 25s inline wait and execute-on-approve', () => {
    const { engine } = makeEngine();
    expect(engine.defaultMode).toBe('hybrid');
    expect(engine.policyFor()).toEqual({ mode: 'hybrid', waitMs: 25_000, executeOnApprove: true });
    expect(engine.policyFor({ approval_mode: 'async' }).waitMs).toBe(0);
    expect(engine.policyFor({ approval_mode: 'sync' }).waitMs).toBe(Number.POSITIVE_INFINITY);
    expect(
      engine.policyFor({ sync_wait_ms: 5, execute_on_approve: false, approval_mode: 'hybrid' })
    ).toEqual({ mode: 'hybrid', waitMs: 5, executeOnApprove: false });
  });

  it('fast path: a decision inside the wait runs the call inline, with no deferred run or grant', async () => {
    const { engine } = makeEngine();
    const next = vi.fn().mockResolvedValue(okResponse('inline'));
    const ctx = makeCtx(engine);
    const reenter = vi.spyOn(ctx, 'reenter');
    const pending = hitlGateMiddleware()(ctx, next);
    await vi.waitFor(() => expect(engine.getPending()).toHaveLength(1));
    expect(engine.getPending()[0].mode).toBe('hybrid');
    engine.approve(engine.getPending()[0].id);
    await expect(pending).resolves.toMatchObject({ text: 'inline' });
    expect(next).toHaveBeenCalledTimes(1);
    expect(reenter).not.toHaveBeenCalled();
    expect(engine.listGrants('agent1')).toHaveLength(0);
  });

  it('spills to a non-error pending response after sync_wait_ms, sending keepalives meanwhile', async () => {
    vi.useFakeTimers();
    const { engine } = makeEngine({ syncWaitMs: 25_000 });
    const ctx = makeCtx(engine);
    ctx.sendProgress = vi.fn();
    const next = vi.fn();
    const pending = hitlGateMiddleware()(ctx, next);
    await vi.advanceTimersByTimeAsync(25_001);
    const response = await pending;

    expect(ctx.sendProgress).toHaveBeenCalledTimes(1); // the 15s keepalive
    expect(next).not.toHaveBeenCalled();
    const result = response.result as { isError?: boolean; structuredContent?: unknown };
    expect(result.isError).toBe(false);
    const [request] = engine.getPending();
    const payload = payloadOf(response);
    expect(result.structuredContent).toEqual(payload);
    expect(payload).toMatchObject({
      status: 'pending',
      approval_id: request.id,
      tool: 'gmail_send_email',
      execute_on_approve: true,
      expires_at: request.expiresAt,
    });
    expect(String(payload.message)).toContain('airlock_await_approval');
    // Never the operator's approval code.
    expect(response.text).not.toContain(request.code);
    // The request stays live on every channel, now as an async (spilled) request.
    expect(request.mode).toBe('async');
    expect(ctx.deps.auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'hitl_pending', hitl_code: request.code })
    );
  });

  it('async mode spills immediately; sync_wait_ms: 0 behaves the same', async () => {
    for (const agentConfig of [{ approval_mode: 'async' as const }, { sync_wait_ms: 0 }]) {
      const { engine } = makeEngine();
      const response = await hitlGateMiddleware()(makeCtx(engine, { agentConfig }), vi.fn());
      expect(payloadOf(response).status).toBe('pending');
      expect(engine.getPending()).toHaveLength(1);
    }
  });

  it('a dropped connection during the inline wait spills instead of cancelling', async () => {
    const { engine } = makeEngine();
    const ac = new AbortController();
    const ctx = makeCtx(engine, { signal: ac.signal });
    const pending = hitlGateMiddleware()(ctx, vi.fn());
    await vi.waitFor(() => expect(engine.getPending()).toHaveLength(1));
    ac.abort(connectionClosedReason());
    const response = await pending;
    expect(payloadOf(response).status).toBe('pending');
    expect(engine.getPending()[0].mode).toBe('async');
    expect(ctx.deps.hitlBatcher.remove).not.toHaveBeenCalled();
  });

  it('an explicit MCP cancellation withdraws the request', async () => {
    const { engine } = makeEngine();
    const ac = new AbortController();
    const ctx = makeCtx(engine, { signal: ac.signal });
    const pending = hitlGateMiddleware()(ctx, vi.fn());
    await vi.waitFor(() => expect(engine.getPending()).toHaveLength(1));
    const { id } = engine.getPending()[0];
    ac.abort('user pressed stop'); // notifications/cancelled aborts with the notification's reason
    await expect(pending).rejects.toBeInstanceOf(ProtocolError);
    expect(engine.hasPending(id)).toBe(false);
    expect(engine.deferred.get(id)?.status).toBe('cancelled');
  });

  it('strict sync mode still cancels on a dropped connection', async () => {
    const { engine } = makeEngine({ defaultMode: 'sync' });
    const ac = new AbortController();
    const pending = hitlGateMiddleware()(makeCtx(engine, { signal: ac.signal }), vi.fn());
    await vi.waitFor(() => expect(engine.getPending()).toHaveLength(1));
    ac.abort(connectionClosedReason());
    await expect(pending).rejects.toThrow(/disconnected/);
    expect(engine.getPending()).toHaveLength(0);
  });

  it('denial inside the wait is an error; a denied spilled call is remembered against retries', async () => {
    const { engine } = makeEngine();
    const inline = hitlGateMiddleware()(makeCtx(engine), vi.fn());
    await vi.waitFor(() => expect(engine.getPending()).toHaveLength(1));
    engine.deny(engine.getPending()[0].id);
    const denied = await inline;
    expect((denied.result as { isError?: boolean }).isError).toBe(true);

    const spilled = await hitlGateMiddleware()(
      makeCtx(engine, { agentConfig: { sync_wait_ms: 0 } }),
      vi.fn()
    );
    engine.deny(payloadOf(spilled).approval_id as string);
    const retry = await hitlGateMiddleware()(makeCtx(engine), vi.fn());
    expect(retry.text).toMatch(/denied by operator/i);
    expect(engine.getPending()).toHaveLength(0);
  });

  it('parallel identical calls inside the inline wait each get their own request', async () => {
    const { engine } = makeEngine();
    const a = hitlGateMiddleware()(makeCtx(engine), vi.fn().mockResolvedValue(okResponse('a')));
    const b = hitlGateMiddleware()(makeCtx(engine), vi.fn().mockResolvedValue(okResponse('b')));
    await vi.waitFor(() => expect(engine.getPending()).toHaveLength(2));
    engine.approveMany(engine.getPending().map((p) => p.id));
    await expect(Promise.all([a, b])).resolves.toMatchObject([{ text: 'a' }, { text: 'b' }]);
  });
});

// ─── Pillar 2: execute-on-approve ─────────────────────────────────────────────

describe('execute-on-approve', () => {
  async function spillCall(
    engine: HitlEngine,
    opts: Parameters<typeof makeCtx>[1] = {}
  ): Promise<{ id: string; ctx: ToolCallContext }> {
    const ctx = makeCtx(engine, { ...opts, agentConfig: { sync_wait_ms: 0, ...opts.agentConfig } });
    const response = await hitlGateMiddleware()(ctx, vi.fn());
    return { id: payloadOf(response).approval_id as string, ctx };
  }

  it('runs the held call through the pipeline the moment it is approved, without a retry grant', async () => {
    const { engine } = makeEngine();
    const execute = vi.fn().mockResolvedValue(okResponse('delivered'));
    const { id } = await spillCall(engine, { execute });
    expect(engine.deferred.get(id)).toMatchObject({ status: 'pending', willExecute: true });
    // Operators see that approving runs the call right away.
    expect(engine.getPending()[0]).toMatchObject({ mode: 'async', executeOnApprove: true });

    engine.approve(id);
    expect(engine.deferred.get(id)?.status).toBe('executing');
    await engine.deferred.settled(id);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(engine.deferred.get(id)).toMatchObject({
      status: 'completed',
      executed: true,
      response: { text: 'delivered' },
    });
    expect(engine.listGrants('agent1')).toHaveLength(0);
  });

  it('runs on any approval path: grant sweep and batch approve', async () => {
    const { engine } = makeEngine();
    const execute = vi.fn().mockResolvedValue(okResponse());
    const first = await spillCall(engine, { execute, args: { to: 'a' } });
    const second = await spillCall(engine, { execute, args: { to: 'b' } });
    const third = await spillCall(engine, { execute, args: { to: 'c' } });

    engine.createOperatorGrant({
      agentId: 'agent1',
      scope: { kind: 'tool', tool: 'gmail/send_email' },
      maxUses: 1,
    });
    engine.approveMany([second.id, third.id]);
    await Promise.all([first.id, second.id, third.id].map((id) => engine.deferred.settled(id)));
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('falls back to the single-use retry grant when execute_on_approve is off or no runner exists', async () => {
    for (const opts of [
      { agentConfig: { execute_on_approve: false } },
      { reentry: false }, // e.g. a context that cannot re-enter the pipeline
    ]) {
      const { engine } = makeEngine();
      const execute = vi.fn().mockResolvedValue(okResponse());
      const { id } = await spillCall(engine, { ...opts, execute });
      expect(engine.deferred.get(id)?.willExecute).toBe(false);
      engine.approve(id);
      await engine.deferred.settled(id);
      expect(execute).not.toHaveBeenCalled();
      expect(engine.deferred.get(id)?.status).toBe('approved');
      expect(engine.listGrants('agent1')).toEqual([
        expect.objectContaining({ source: 'async', approvalId: id }),
      ]);
    }
  });

  it('records failed runs: thrown errors and isError results', async () => {
    const { engine } = makeEngine();
    const thrown = await spillCall(engine, {
      args: { to: 'x' },
      execute: () => Promise.reject(new Error('smtp down')),
    });
    const errored = await spillCall(engine, {
      args: { to: 'y' },
      execute: () =>
        Promise.resolve({
          result: { content: [{ type: 'text', text: 'bad address' }], isError: true },
          text: 'bad address',
        }),
    });
    engine.approve(thrown.id);
    engine.approve(errored.id);
    await Promise.all([engine.deferred.settled(thrown.id), engine.deferred.settled(errored.id)]);
    expect(engine.deferred.get(thrown.id)).toMatchObject({ status: 'failed', error: 'smtp down' });
    expect(engine.deferred.get(errored.id)).toMatchObject({
      status: 'failed',
      error: 'bad address',
    });
  });

  it('denial, timeout and cancellation drop the runner', async () => {
    const { engine } = makeEngine();
    const execute = vi.fn();
    const { id } = await spillCall(engine, { execute });
    engine.deny(id);
    expect(engine.deferred.get(id)).toMatchObject({ status: 'denied', willExecute: false });
    expect(execute).not.toHaveBeenCalled();
  });

  it('an identical retry gets the in-flight run once instead of running the call twice', async () => {
    const { engine } = makeEngine();
    let finish!: (value: ToolCallResponse) => void;
    const execute = vi.fn(() => new Promise<ToolCallResponse>((resolve) => (finish = resolve)));
    const { id } = await spillCall(engine, { execute });
    engine.approve(id);

    const retry = hitlGateMiddleware()(makeCtx(engine, { execute }), vi.fn());
    finish(okResponse('once'));
    await expect(retry).resolves.toMatchObject({ text: 'once' });
    expect(execute).toHaveBeenCalledTimes(1);

    // Redeemed: the next identical call is a fresh request again.
    const again = await hitlGateMiddleware()(
      makeCtx(engine, { execute, agentConfig: { sync_wait_ms: 0 } }),
      vi.fn()
    );
    expect(payloadOf(again).status).toBe('pending');
    expect(payloadOf(again).approval_id).not.toBe(id);
  });

  it('only an identical retry from the same agent session receives the run result', async () => {
    const { engine } = makeEngine();
    const execute = vi.fn().mockResolvedValue(okResponse('mine'));
    const inSession = (sessionId: string) => {
      const ctx = makeCtx(engine, { execute, agentConfig: { sync_wait_ms: 0 } });
      ctx.meta.downstreamSessionId = sessionId;
      return ctx;
    };
    const first = await hitlGateMiddleware()(inSession('s1'), vi.fn());
    const id = payloadOf(first).approval_id as string;
    engine.approve(id);
    await engine.deferred.settled(id);

    const otherSession = await hitlGateMiddleware()(inSession('s2'), vi.fn());
    expect(payloadOf(otherSession)).toMatchObject({ status: 'pending' });
    expect(payloadOf(otherSession).approval_id).not.toBe(id);

    const sameSession = await hitlGateMiddleware()(inSession('s1'), vi.fn());
    expect(sameSession.text).toBe('mine');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('a retry while still pending waits on the same request and receives the run result', async () => {
    const { engine } = makeEngine();
    const execute = vi.fn().mockResolvedValue(okResponse('ran'));
    const { id } = await spillCall(engine, { execute });

    const retry = hitlGateMiddleware()(makeCtx(engine, { execute }), vi.fn());
    await Promise.resolve();
    expect(engine.getPending()).toHaveLength(1);
    engine.approve(id);
    await expect(retry).resolves.toMatchObject({ text: 'ran' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('persists the spill so dashboards reading the database see it, and drops it on restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'airlock-hybrid-meta-'));
    const logger = new AuditLogger({
      db_path: join(dir, 'audit.db'),
      redact_fields: [],
      retention_days: 30,
    });
    try {
      const engine = new HitlEngine(logger, makeProvider(), 60_000);
      const { id } = await spillCall(engine);
      const meta = () => JSON.parse(logger.getHitlById(id)!.meta!) as Record<string, unknown>;
      expect(meta()).toMatchObject({ kind: 'call', mode: 'async', executeOnApprove: true });

      // After a restart no runner exists, so the row must stop advertising execute-on-approve.
      const restarted = new HitlEngine(logger, makeProvider(), 60_000);
      await restarted.recoverPending();
      expect(meta().executeOnApprove).toBeUndefined();
      expect(restarted.getPending()[0].executeOnApprove).toBeUndefined();
    } finally {
      logger.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recovers a hybrid request after restart as async, approving it with a retry grant', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'airlock-hybrid-recovery-'));
    const logger = new AuditLogger({
      db_path: join(dir, 'audit.db'),
      redact_fields: [],
      retention_days: 30,
    });
    try {
      const fingerprint = fingerprintCall('gmail/send_email', { to: 'a' });
      logger.insertHitl({
        id: 'hybridcall',
        code: 'HYBRID12',
        agent_id: 'agent1',
        tool: 'gmail/send_email',
        args: '{}',
        status: 'pending',
        created_at: new Date().toISOString(),
        meta: JSON.stringify({
          kind: 'call',
          mode: 'hybrid',
          subject: {
            agentId: 'agent1',
            tool: 'gmail/send_email',
            fingerprint,
            provider: 'gmail',
            tier: 'destructive',
            escalated: false,
          },
        }),
      });
      const engine = new HitlEngine(logger, makeProvider(), 60_000);
      await engine.recoverPending();
      expect(engine.getPending()).toMatchObject([{ id: 'hybridcall', mode: 'async' }]);
      engine.approve('hybridcall');
      expect(engine.listGrants('agent1')).toEqual([
        expect.objectContaining({ source: 'async', approvalId: 'hybridcall' }),
      ]);
    } finally {
      logger.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('execute-on-approve and the rate limiter', () => {
  afterEach(() => resetRateLimiterState());

  it('a call answered "pending" keeps its slot, and its approved run is not throttled again', async () => {
    const { engine } = makeEngine();
    const downstream = vi.fn((ctx: ToolCallContext) => {
      markDispatched(ctx);
      return Promise.resolve(okResponse(String(ctx.args.to)));
    });
    const chain = compose([
      rateLimiterMiddleware({ max_requests: 1, window_ms: 60_000 }),
      hitlGateMiddleware(),
      (ctx) => downstream(ctx),
    ]);
    const call = (args: Record<string, unknown>, ask: boolean) => {
      const ctx = makeCtx(engine, { args, agentConfig: { sync_wait_ms: 0 }, reentry: false });
      ctx.meta = ask ? { policyAsk: true } : {};
      ctx.reenter = (prepare) => {
        const fresh: ToolCallContext = { ...ctx, meta: { policyAsk: true }, startedAt: Date.now() };
        prepare(fresh);
        return chain(fresh, () => Promise.reject(new Error('unterminated')));
      };
      return chain(ctx, () => Promise.reject(new Error('unterminated')));
    };

    const pending = await call({ to: 'approved-later' }, true);
    const id = payloadOf(pending).approval_id as string;
    // The pending call holds the agent's only slot, so an unrelated allowed call is throttled...
    await expect(call({ to: 'other' }, false)).rejects.toThrow(/Rate limit exceeded/);

    // ...and the approved run goes through without being counted (or throttled) a second time.
    engine.approve(id);
    await engine.deferred.settled(id);
    expect(engine.deferred.get(id)).toMatchObject({
      status: 'completed',
      response: { text: 'approved-later' },
    });
    expect(downstream).toHaveBeenCalledTimes(1);
  });

  it('a call that only waits for a retry grant is refunded as before', async () => {
    const { engine } = makeEngine();
    const chain = compose([
      rateLimiterMiddleware({ max_requests: 1, window_ms: 60_000 }),
      hitlGateMiddleware(),
      (ctx) => {
        markDispatched(ctx);
        return Promise.resolve(okResponse());
      },
    ]);
    const ctx = makeCtx(engine, {
      agentConfig: { sync_wait_ms: 0, execute_on_approve: false },
      reentry: false,
    });
    await chain(ctx, () => Promise.reject(new Error('unterminated')));
    const allowed = makeCtx(engine, { args: { to: 'other' }, reentry: false });
    allowed.meta = {};
    await expect(chain(allowed, () => Promise.reject(new Error('x')))).resolves.toMatchObject({
      text: 'sent',
    });
  });
});

describe('DeferredExecutionStore', () => {
  const runner = (text: string) => () => Promise.resolve(okResponse(text));

  it('caps held runners, truncates large results, and expires decided entries after the TTL', async () => {
    vi.useFakeTimers();
    const store = new DeferredExecutionStore({
      ttlMs: () => 1_000,
      maxRunners: 1,
      maxResultChars: 10,
    });
    for (const id of ['a', 'b']) store.open({ id, agentId: 'x', tool: 't', kind: 'call' });
    expect(store.detach('a', runner('0123456789abcdef'))).toBe(true);
    expect(store.detach('b', runner('b'))).toBe(false); // over the cap: grant fallback

    expect(store.approve('a')).toBe('executing');
    await store.settled('a');
    const done = store.get('a')!;
    expect(done.response?.truncated).toBe(true);
    expect(done.response?.text).toMatch(/^0123456789\n\[Airlock: result truncated/);

    vi.advanceTimersByTime(1_001);
    expect(store.get('a')).toBeUndefined();
    expect(store.get('b')?.status).toBe('pending'); // undecided entries never expire
  });

  it('emits one decision per approval, flagged executed and detached', async () => {
    const store = new DeferredExecutionStore({ ttlMs: () => 60_000 });
    const decisions: unknown[] = [];
    store.onDecision((decision) => decisions.push(decision));
    store.open({ id: 'run', agentId: 'x', tool: 't', kind: 'call' });
    store.detach('run', runner('ok'));
    store.open({ id: 'inline', agentId: 'x', tool: 't', kind: 'call' });
    store.approve('run');
    store.approve('inline');
    await store.settled('run');
    expect(decisions).toEqual([
      expect.objectContaining({ approvalId: 'inline', status: 'approved', detached: false }),
      expect.objectContaining({
        approvalId: 'run',
        status: 'completed',
        executed: true,
        detached: true,
      }),
    ]);
  });
});

// ─── Pillar 3: airlock_await_approval & airlock_ask_user ──────────────────────

describe('airlock_await_approval and airlock_ask_user', () => {
  function makeAdapter(engine: HitlEngine, agentConfig: Partial<AgentConfig> = {}) {
    return new AirlockBackendAdapter({
      hitlEngine: engine,
      hitlBatcher: { add: vi.fn() } as any,
      getAgentConfig: () => agentConfig as AgentConfig,
    });
  }

  async function spill(engine: HitlEngine, args: Record<string, unknown>, execute = okResponse) {
    const ctx = makeCtx(engine, {
      args,
      agentConfig: { sync_wait_ms: 0 },
      execute: () => Promise.resolve(execute(String(args.to))),
    });
    return payloadOf(await hitlGateMiddleware()(ctx, vi.fn())).approval_id as string;
  }

  it('returns the executed call result inline, with nothing to retry', async () => {
    const { engine } = makeEngine();
    const adapter = makeAdapter(engine);
    const id = await spill(engine, { to: 'boss' });
    const code = engine.getPending()[0].code;

    const peek = await adapter.call({
      tool: 'airlock/await_approval',
      agentId: 'agent1',
      args: { id, wait_seconds: 0 },
    });
    expect(peek.data).toMatchObject({ id, status: 'pending', execute_on_approve: true });

    const waiting = adapter.call({
      tool: 'airlock/await_approval',
      agentId: 'agent1',
      args: { id },
    });
    engine.approve(id);
    const done = await waiting;
    expect(done.data).toMatchObject({
      id,
      status: 'completed',
      executed: true,
      result: { text: 'boss' },
    });
    expect(JSON.stringify(done.data)).not.toContain(code);
  });

  it('waits on several ids: any by default, or all', async () => {
    const { engine } = makeEngine();
    const adapter = makeAdapter(engine);
    const a = await spill(engine, { to: 'a' });
    const b = await spill(engine, { to: 'b' });

    const any = adapter.call({
      tool: 'airlock/await_approval',
      agentId: 'agent1',
      args: { ids: [a, b, 'nope'], wait_seconds: 5 },
    });
    engine.deny(b);
    const anyResult = (await any).data as { done: boolean; approvals: Array<{ status: string }> };
    expect(anyResult.done).toBe(true);
    expect(anyResult.approvals.map((view) => view.status)).toEqual([
      'pending',
      'denied',
      'unknown',
    ]);

    const all = adapter.call({
      tool: 'airlock/await_approval',
      agentId: 'agent1',
      args: { ids: [a, b], wait_for: 'all', wait_seconds: 5 },
    });
    await Promise.resolve();
    engine.approve(a);
    const allResult = (await all).data as { done: boolean; approvals: Array<{ status: string }> };
    expect(allResult).toMatchObject({ wait_for: 'all', done: true });
    expect(allResult.approvals.map((view) => view.status)).toEqual(['completed', 'denied']);
  });

  it('rejects foreign ids, too many ids, and missing ids', async () => {
    const { engine } = makeEngine();
    const adapter = makeAdapter(engine);
    const id = await spill(engine, { to: 'a' });
    const call = (agentId: string, args: Record<string, unknown>) =>
      adapter.call({ tool: 'airlock/await_approval', agentId, args });
    expect((await call('agent2', { id, wait_seconds: 0 })).success).toBe(false);
    const foreignMulti = await call('agent2', { ids: [id], wait_seconds: 0 });
    expect(foreignMulti.data).toMatchObject({ approvals: [{ id, status: 'unknown' }] });
    expect(
      (await call('agent1', { ids: Array.from({ length: 51 }, (_, i) => `${i}`) })).success
    ).toBe(false);
    expect((await call('agent1', {})).success).toBe(false);
  });

  it('ask_user spills to a pending handle and await_approval returns the chosen answer', async () => {
    const { engine } = makeEngine();
    const adapter = makeAdapter(engine, { sync_wait_ms: 0 });
    const asked = await adapter.call({
      tool: 'airlock/ask_user',
      agentId: 'agent1',
      args: { question: 'Which env?', choices: ['staging', 'prod'] },
    });
    expect(asked.success).toBe(true);
    const handle = asked.data as Record<string, unknown>;
    expect(handle.status).toBe('pending');
    const id = handle.approval_id as string;
    const [request] = engine.getPending();
    expect(request.args).toMatchObject({ choices: ['staging', 'prod'] });
    expect(JSON.stringify(handle)).not.toContain(request.code);

    expect(() => engine.approve(id, { answer: 'qa' })).toThrow(GrantSpecError);
    engine.approve(id, { answer: 'prod' });
    const answered = await adapter.call({
      tool: 'airlock/await_approval',
      agentId: 'agent1',
      args: { id, wait_seconds: 0 },
    });
    expect(answered.data).toMatchObject({
      status: 'approved',
      answer: 'prod',
      message: 'The user answered: prod',
    });
  });

  it('ask_user answers inline within the wait, and stays a plain yes/no without choices', async () => {
    const { engine } = makeEngine();
    const adapter = makeAdapter(engine);
    const asked = adapter.call({
      tool: 'airlock/ask_user',
      agentId: 'agent1',
      args: { question: 'Deploy now?' },
    });
    await vi.waitFor(() => expect(engine.getPending()).toHaveLength(1));
    engine.deny(engine.getPending()[0].id);
    await expect(asked).resolves.toMatchObject({
      success: true,
      data: { status: 'denied', approved: false },
    });

    const bad = await adapter.call({
      tool: 'airlock/ask_user',
      agentId: 'agent1',
      args: { question: 'x', choices: ['only one'] },
    });
    expect(bad.success).toBe(false);
  });

  it('only questions take an answer', async () => {
    const { engine } = makeEngine();
    const id = await spill(engine, { to: 'a' });
    expect(() => engine.approve(id, { answer: 'yes' })).toThrow(GrantSpecError);
    expect(engine.hasPending(id)).toBe(true);
  });

  it('request_approval spills plans in hybrid mode too', async () => {
    const { engine } = makeEngine();
    const adapter = new AirlockBackendAdapter({
      hitlEngine: engine,
      hitlBatcher: { add: vi.fn() } as any,
      getAgentConfig: () => ({ sync_wait_ms: 0 }) as AgentConfig,
      getAgentTools: () => [
        {
          tool: { name: 'gmail/read_email', inputSchema: { type: 'object' } },
          decision: 'ask',
          providerId: 'gmail',
          resolvedName: 'gmail/read_email',
        },
      ],
    });
    const result = await adapter.call({
      tool: 'airlock/request_approval',
      agentId: 'agent1',
      args: { reason: 'x', calls: [{ tool: 'gmail/read_email', arguments: { id: '1' } }] },
    });
    expect(result.data).toMatchObject({ status: 'pending' });
    expect(engine.getPending()[0]).toMatchObject({ kind: 'plan', mode: 'async' });
  });

  it('POST /hitl/approve/:id accepts an answer', async () => {
    const { engine } = makeEngine();
    const app = Fastify({ logger: false });
    await app.register(hitlApiPlugin, { engine });
    try {
      const ticket = engine.create({
        agentId: 'agent1',
        tool: 'airlock/ask_user',
        args: { question: 'Color?', choices: ['red', 'blue'] },
        kind: 'question',
      });
      const bad = await app.inject({
        method: 'POST',
        url: `/hitl/approve/${ticket.id}`,
        payload: { answer: 'green' },
      });
      expect(bad.statusCode).toBe(400);
      const ok = await app.inject({
        method: 'POST',
        url: `/hitl/approve/${ticket.id}`,
        payload: { answer: 'blue' },
      });
      expect(ok.statusCode).toBe(200);
      expect(engine.deferred.get(ticket.id)?.answer).toBe('blue');
    } finally {
      await app.close();
    }
  });
});

// ─── Pillar 4: airlock/approval_decided events ────────────────────────────────

describe('airlock/approval_decided event', () => {
  function makeService(engine: HitlEngine) {
    const agents: Record<string, AgentConfig> = {
      agent1: { allow: [], ask: ['gmail/*'], deny: [], tool_overrides: {} } as AgentConfig,
      agent2: { allow: [], ask: ['gmail/*'], deny: [], tool_overrides: {} } as AgentConfig,
      plain: { allow: ['notes/*'], ask: [], deny: [], tool_overrides: {} } as AgentConfig,
    };
    const allowlist = new AllowlistEngine(agents);
    const streamManager = new EventStreamManager(() => ({
      maxEventStreamsPerAgent: 4,
      maxEventStreamsGlobal: 16,
    }));
    const service = new EventService({
      pool: {} as any,
      registry: { getFiltered: () => [], hasEventsFor: () => false } as any,
      allowlist,
      streamManager,
      hitlEngine: engine,
      hitlBatcher: { add: vi.fn() } as any,
      auditLogger: makeAuditLogger(),
      getAgentConfig: (id) => agents[id],
    });
    return { service, agents, streamManager };
  }

  function eventCtx(
    agentId: string,
    signal?: AbortSignal
  ): EventRequestContext & { notify: ReturnType<typeof vi.fn> } {
    return {
      agentId,
      agentConfig: {} as AgentConfig,
      requestId: 7,
      ...(signal ? { signal } : {}),
      notify: vi.fn().mockResolvedValue(undefined),
    };
  }

  async function spillFor(engine: HitlEngine, agentId: string, to: string) {
    const ctx = makeCtx(engine, { args: { to }, agentConfig: { sync_wait_ms: 0 } });
    ctx.agentId = agentId;
    return payloadOf(await hitlGateMiddleware()(ctx, vi.fn())).approval_id as string;
  }

  it('is listed and advertised only for agents that can hit an approval', () => {
    const { engine } = makeEngine();
    const { service, agents } = makeService(engine);
    expect(service.handleList('agent1', {}).events.map((e) => e.name)).toEqual([
      APPROVAL_DECIDED_EVENT,
    ]);
    expect(service.shouldAdvertiseFor('agent1', agents.agent1)).toBe(true);
    expect(service.handleList('plain', {}).events).toEqual([]);
    expect(service.shouldAdvertiseFor('plain', agents.plain)).toBe(false);
  });

  it('polls decisions of pending approvals only, scoped to the agent, with a cursor', async () => {
    const { engine } = makeEngine();
    const { service } = makeService(engine);

    // An inline decision needs no wake-up and is not emitted.
    const inline = hitlGateMiddleware()(makeCtx(engine), vi.fn().mockResolvedValue(okResponse()));
    await vi.waitFor(() => expect(engine.getPending()).toHaveLength(1));
    engine.approve(engine.getPending()[0].id);
    await inline;

    const mine = await spillFor(engine, 'agent1', 'a');
    const theirs = await spillFor(engine, 'agent2', 'b');
    const code = engine.getPending().find((p) => p.id === mine)!.code;
    engine.approve(mine);
    engine.deny(theirs);
    await engine.deferred.settled(mine);

    const first = await service.handlePoll(eventCtx('agent1'), { name: APPROVAL_DECIDED_EVENT });
    expect(first.events).toHaveLength(1);
    expect(first.events[0].data).toEqual({
      approvalId: mine,
      tool: 'gmail_send_email',
      kind: 'call',
      status: 'completed',
      executed: true,
      decidedAt: expect.any(String),
    });
    expect(JSON.stringify(first)).not.toContain(code);
    expect(JSON.stringify(first)).not.toContain(theirs);

    const next = await service.handlePoll(eventCtx('agent1'), {
      name: APPROVAL_DECIDED_EVENT,
      cursor: first.cursor,
    });
    expect(next.events).toEqual([]);

    const other = await service.handlePoll(eventCtx('agent2'), { name: APPROVAL_DECIDED_EVENT });
    expect(other.events.map((e) => e.data.status)).toEqual(['denied']);

    await expect(
      service.handlePoll(eventCtx('plain'), { name: APPROVAL_DECIDED_EVENT })
    ).rejects.toThrow(/not allowed/);
    await expect(
      service.handlePoll(eventCtx('agent1'), { name: APPROVAL_DECIDED_EVENT, cursor: 'garbage' })
    ).rejects.toThrow(/cursor/);
  });

  it('pushes decisions to an open stream for that agent only', async () => {
    const { engine } = makeEngine();
    const { service, streamManager } = makeService(engine);
    const ac = new AbortController();
    const ctx = eventCtx('agent1', ac.signal);
    const stream = service.handleStream(ctx, { name: APPROVAL_DECIDED_EVENT });
    await vi.waitFor(() =>
      expect(ctx.notify).toHaveBeenCalledWith(
        expect.objectContaining({ method: EVENT_NOTIFICATIONS.active })
      )
    );
    expect(streamManager.snapshot().perAgent.agent1).toBe(1);

    const theirs = await spillFor(engine, 'agent2', 'x');
    engine.deny(theirs);
    const mine = await spillFor(engine, 'agent1', 'y');
    engine.deny(mine);

    await vi.waitFor(() =>
      expect(ctx.notify).toHaveBeenCalledWith(
        expect.objectContaining({ method: EVENT_NOTIFICATIONS.event })
      )
    );
    const events = ctx.notify.mock.calls
      .map(([notification]) => notification as { method: string; params: { data?: unknown } })
      .filter((notification) => notification.method === EVENT_NOTIFICATIONS.event);
    expect(events.map((e) => e.params.data)).toEqual([
      expect.objectContaining({ approvalId: mine, status: 'denied', executed: false }),
    ]);

    ac.abort();
    await expect(stream).resolves.toMatchObject({ resultType: 'complete' });
    expect(streamManager.snapshot().total).toBe(0);
  });
});
