import { describe, it, expect, vi, beforeEach } from 'vitest';
import { allowlistMiddleware } from '../../src/middleware/core/allowlist.js';
import { execPolicyMiddleware } from '../../src/middleware/core/exec-policy.js';
import { hitlGateMiddleware } from '../../src/middleware/core/hitl-gate.js';
import { rateLimiterMiddleware, resetRateLimiterState } from '../../src/middleware/core/rate-limiter.js';
import type { ToolCallContext, ToolCallResponse } from '../../src/middleware/types.js';

const okResponse: ToolCallResponse = { result: 'ok', text: 'ok' };
const okNext = async () => okResponse;

function makeCtx(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    callId: 'test',
    agentId: 'agent1',
    agentConfig: {
      allow: [], ask: [], deny: [], tool_overrides: {}, middleware: [],
      exec: { allow: [], ask: [], deny: ['*'], env: {}, default_timeout_ms: 5000 },
      http: { domain_allowlist: [], max_response_bytes: 1048576, timeout_ms: 5000 },
    },
    toolName: 'github/create_pr',
    args: {},
    meta: {},
    deps: {
      registry: {} as any,
      allowlist: { evaluate: vi.fn().mockReturnValue('allow') } as any,
      hitlEngine: {} as any,
      hitlBatcher: {} as any,
      auditLogger: { log: vi.fn() } as any,
      securityConfig: { blocked_hosts: [], allowed_local: [] },
    },
    startedAt: Date.now(),
    ...overrides,
  };
}

describe('allowlistMiddleware', () => {
  it('passes through when allowed', async () => {
    const mw = allowlistMiddleware();
    const ctx = makeCtx();
    const result = await mw(ctx, okNext);
    expect(result.text).toBe('ok');
  });

  it('throws when denied', async () => {
    const mw = allowlistMiddleware();
    const ctx = makeCtx();
    (ctx.deps.allowlist.evaluate as any).mockReturnValue('deny');
    await expect(mw(ctx, okNext)).rejects.toThrow('Tool not available');
  });

  it('sets needsApproval for ask decision', async () => {
    const mw = allowlistMiddleware();
    const ctx = makeCtx();
    (ctx.deps.allowlist.evaluate as any).mockReturnValue('ask');
    await mw(ctx, okNext);
    expect(ctx.meta.needsApproval).toBe(true);
  });
});

describe('execPolicyMiddleware', () => {
  it('skips non-exec tools', async () => {
    const mw = execPolicyMiddleware();
    const ctx = makeCtx({ toolName: 'github/list' });
    const result = await mw(ctx, okNext);
    expect(result.text).toBe('ok');
  });

  it('throws when command is missing', async () => {
    const mw = execPolicyMiddleware();
    const ctx = makeCtx({ toolName: 'exec/run', args: {} });
    await expect(mw(ctx, okNext)).rejects.toThrow('exec/run requires a string command');
  });

  it('denies matching deny pattern', async () => {
    const mw = execPolicyMiddleware();
    const ctx = makeCtx({
      toolName: 'exec/run',
      args: { command: 'sudo rm -rf /' },
      agentConfig: {
        ...makeCtx().agentConfig,
        exec: { allow: [], ask: [], deny: ['sudo*'], env: {}, default_timeout_ms: 5000 },
      },
    });
    await expect(mw(ctx, okNext)).rejects.toThrow('Command denied by policy');
  });
});

describe('hitlGateMiddleware', () => {
  it('passes through when needsApproval is false', async () => {
    const mw = hitlGateMiddleware();
    const ctx = makeCtx();
    const result = await mw(ctx, okNext);
    expect(result.text).toBe('ok');
  });
});

describe('rateLimiterMiddleware', () => {
  beforeEach(() => resetRateLimiterState());

  it('allows requests within limit', async () => {
    const mw = rateLimiterMiddleware({ max_requests: 3, window_ms: 1000 });
    const ctx = makeCtx();

    await mw(ctx, okNext);
    await mw(ctx, okNext);
    await mw(ctx, okNext);
  });

  it('rejects when limit exceeded', async () => {
    const mw = rateLimiterMiddleware({ max_requests: 2, window_ms: 60000 });
    const ctx = makeCtx();

    await mw(ctx, okNext);
    await mw(ctx, okNext);
    await expect(mw(ctx, okNext)).rejects.toThrow('Rate limit exceeded');
  });

  it('separates limits per-tool', async () => {
    const mw = rateLimiterMiddleware({ max_requests: 1, window_ms: 60000, per: 'tool' });
    const ctx1 = makeCtx({ toolName: 'tool/a' });
    const ctx2 = makeCtx({ toolName: 'tool/b' });

    await mw(ctx1, okNext);
    await mw(ctx2, okNext);
    await expect(mw(ctx1, okNext)).rejects.toThrow('Rate limit exceeded');
  });
});

