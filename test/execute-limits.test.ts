import { describe, it, expect, beforeEach } from 'vitest';
import { executeMiddleware, resetExecuteState } from '../src/middleware/core/execute.js';
import type { ToolCallContext, ToolCallResponse } from '../src/middleware/types.js';
import type { LimitsConfig } from '../src/config/schema.js';

function makeCtx(
  limits: LimitsConfig,
  call: () => Promise<unknown>,
  overrides: Partial<ToolCallContext> = {}
): ToolCallContext {
  return {
    callId: 'c1',
    agentId: 'agentX',
    agentConfig: { limits } as any,
    toolName: 'prov/tool',
    args: {},
    meta: {},
    deps: {
      registry: { call: () => call() },
      auditLogger: { log: () => {} },
      securityConfig: { blocked_hosts: [], allowed_local: [] },
    } as any,
    startedAt: Date.now(),
    ...overrides,
  };
}

const terminal = async (): Promise<ToolCallResponse> => {
  throw new Error('chain did not terminate');
};

describe('execute middleware — per-agent concurrency cap', () => {
  beforeEach(() => resetExecuteState());

  it('rejects a call once the agent is at its executing cap', async () => {
    const mw = executeMiddleware();
    const limits: LimitsConfig = { max_concurrent_calls_per_agent: 1 };

    let release!: () => void;
    const blocker = new Promise<unknown>((resolve) => {
      release = () => resolve({ content: [{ type: 'text', text: 'done' }] });
    });

    // First call occupies the only slot and stays in flight.
    const first = mw(makeCtx(limits, () => blocker), terminal);

    // Second call from the same agent is rejected by the bulkhead.
    await expect(mw(makeCtx(limits, () => Promise.resolve({})), terminal)).rejects.toThrow(
      /concurrency cap/i
    );

    // Releasing the first frees the slot; a subsequent call succeeds.
    release();
    await first;
    await expect(mw(makeCtx(limits, () => Promise.resolve({})), terminal)).resolves.toBeDefined();
  });

  it('does not cap a different agent', async () => {
    const mw = executeMiddleware();
    const limits: LimitsConfig = { max_concurrent_calls_per_agent: 1 };
    const blocker = new Promise<unknown>(() => {});

    void mw(makeCtx(limits, () => blocker, { agentId: 'A' }), terminal);
    await expect(
      mw(makeCtx(limits, () => Promise.resolve({}), { agentId: 'B' }), terminal)
    ).resolves.toBeDefined();
  });
});

describe('execute middleware — execution timeout (HITL-excluded by construction)', () => {
  beforeEach(() => resetExecuteState());

  it('aborts a downstream call that exceeds call_execution_timeout_ms', async () => {
    const mw = executeMiddleware();
    const limits: LimitsConfig = { call_execution_timeout_ms: 20 };
    const neverResolves = new Promise<unknown>(() => {});

    await expect(mw(makeCtx(limits, () => neverResolves), terminal)).rejects.toThrow(
      /exceeded 20ms/
    );
  });

  it('does not time out when the deadline is 0 (disabled)', async () => {
    const mw = executeMiddleware();
    const limits: LimitsConfig = { call_execution_timeout_ms: 0 };
    await expect(
      mw(makeCtx(limits, () => Promise.resolve({ ok: true })), terminal)
    ).resolves.toBeDefined();
  });
});
