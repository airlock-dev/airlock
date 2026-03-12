import { describe, it, expect, vi, afterEach } from 'vitest';
import { sensitivityClassifierMiddleware } from '../../src/middleware/detectors/sensitivity-classifier.js';
import type { ToolCallContext, ToolCallResponse } from '../../src/middleware/types.js';

function makeCtx(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    callId: 'test',
    agentId: 'agent1',
    agentConfig: {} as any,
    toolName: 'test/tool',
    args: {},
    meta: {},
    deps: {
      registry: {} as any,
      allowlist: {} as any,
      hitlEngine: {} as any,
      hitlBatcher: {} as any,
      auditLogger: { log: vi.fn() } as any,
      securityConfig: { blocked_hosts: [], allowed_local: [] },
    },
    startedAt: Date.now(),
    ...overrides,
  };
}

function makeNext(text: string): () => Promise<ToolCallResponse> {
  return async () => ({ result: text, text });
}

describe('sensitivityClassifierMiddleware — heuristic', () => {
  it('detects JWT tokens in response and logs (no escalation on response phase)', async () => {
    const mw = sensitivityClassifierMiddleware({ mode: 'escalate', threshold: 0.5, backend: 'heuristic' });
    const ctx = makeCtx();
    await mw(ctx, makeNext('token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456'));
    expect(ctx.meta.needsHitl).toBeUndefined();
    expect(ctx.deps.auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'sensitivity_response' }),
    );
  });

  it('detects internal IPs', async () => {
    const mw = sensitivityClassifierMiddleware({ mode: 'detect', threshold: 0.3, backend: 'heuristic' });
    const ctx = makeCtx();
    await mw(ctx, makeNext('server at 192.168.1.100'));
    expect(ctx.deps.auditLogger.log).toHaveBeenCalled();
  });

  it('detects password fields in response and logs (no escalation on response phase)', async () => {
    const mw = sensitivityClassifierMiddleware({ mode: 'escalate', threshold: 0.7, backend: 'heuristic' });
    const ctx = makeCtx();
    await mw(ctx, makeNext('password: "hunter2"'));
    expect(ctx.meta.needsHitl).toBeUndefined();
    expect(ctx.deps.auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'sensitivity_response' }),
    );
  });

  it('detects phone numbers at low threshold', async () => {
    const mw = sensitivityClassifierMiddleware({ mode: 'detect', threshold: 0.2, backend: 'heuristic' });
    const ctx = makeCtx();
    await mw(ctx, makeNext('Call me at (555) 123-4567'));
    expect(ctx.deps.auditLogger.log).toHaveBeenCalled();
  });

  it('detects emails at low threshold', async () => {
    const mw = sensitivityClassifierMiddleware({ mode: 'detect', threshold: 0.2, backend: 'heuristic' });
    const ctx = makeCtx();
    await mw(ctx, makeNext('user@example.com'));
    expect(ctx.deps.auditLogger.log).toHaveBeenCalled();
  });

  it('does not escalate when already escalated', async () => {
    const mw = sensitivityClassifierMiddleware({ mode: 'escalate', threshold: 0.7, backend: 'heuristic' });
    const ctx = makeCtx({ meta: { needsHitl: true } });
    await mw(ctx, makeNext('SSN: 123-45-6789'));
    // needsHitl was already true, so it stays true but no duplicate set
    expect(ctx.meta.needsHitl).toBe(true);
  });

  it('scans args in pre-execution phase', async () => {
    const mw = sensitivityClassifierMiddleware({ mode: 'escalate', threshold: 0.7, backend: 'heuristic' });
    const ctx = makeCtx({ args: { data: 'AKIAIOSFODNN7EXAMPLE' } });
    await mw(ctx, makeNext('clean output'));
    expect(ctx.meta.needsHitl).toBe(true);
    expect(ctx.deps.auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'sensitivity_args' }),
    );
  });
});

describe('sensitivityClassifierMiddleware — llm backend', () => {
  afterEach(() => vi.restoreAllMocks());

  it('falls back to heuristic when LLM import fails', async () => {
    // LLM backend with a model that won't be available — should fall back
    const mw = sensitivityClassifierMiddleware({
      mode: 'escalate',
      threshold: 0.7,
      backend: 'llm',
      model: 'nonexistent-model',
    });
    // SSN in args — heuristic fallback should catch it and escalate in pre-execution phase
    const ctx = makeCtx({ args: { data: 'SSN: 123-45-6789' } });
    await mw(ctx, makeNext('clean output'));
    expect(ctx.meta.needsHitl).toBe(true);
  });
});
