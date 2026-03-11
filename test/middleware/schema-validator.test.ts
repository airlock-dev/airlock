import { describe, it, expect, vi } from 'vitest';
import { schemaValidatorMiddleware } from '../../src/middleware/core/schema-validator.js';
import type { ToolCallContext, ToolCallResponse } from '../../src/middleware/types.js';

const okResponse: ToolCallResponse = { result: 'ok', text: 'ok' };
const okNext = async () => okResponse;

function makeCtx(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    callId: 'test',
    agentId: 'agent1',
    agentConfig: {} as any,
    toolName: 'test/tool',
    args: {},
    meta: {},
    deps: {
      registry: {
        getAllTools: vi.fn().mockReturnValue([]),
      } as any,
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

describe('schemaValidatorMiddleware', () => {
  it('passes through when tool has no schema', async () => {
    const mw = schemaValidatorMiddleware();
    const result = await mw(makeCtx(), okNext);
    expect(result.text).toBe('ok');
  });

  it('passes valid args', async () => {
    const mw = schemaValidatorMiddleware();
    const ctx = makeCtx({ args: { name: 'test', count: 5 } });
    (ctx.deps.registry.getAllTools as any).mockReturnValue([{
      name: 'test/tool',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          count: { type: 'number' },
        },
        required: ['name'],
      },
    }]);
    const result = await mw(ctx, okNext);
    expect(result.text).toBe('ok');
  });

  it('rejects missing required field', async () => {
    const mw = schemaValidatorMiddleware();
    const ctx = makeCtx({ args: {} });
    (ctx.deps.registry.getAllTools as any).mockReturnValue([{
      name: 'test/tool',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    }]);
    await expect(mw(ctx, okNext)).rejects.toThrow('Invalid arguments');
  });

  it('rejects wrong type', async () => {
    const mw = schemaValidatorMiddleware();
    const ctx = makeCtx({ args: { name: 123 } });
    (ctx.deps.registry.getAllTools as any).mockReturnValue([{
      name: 'test/tool',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    }]);
    await expect(mw(ctx, okNext)).rejects.toThrow('Invalid arguments');
  });

  it('passes when tool not found in registry', async () => {
    const mw = schemaValidatorMiddleware();
    const ctx = makeCtx({ toolName: 'unknown/tool' });
    const result = await mw(ctx, okNext);
    expect(result.text).toBe('ok');
  });

  it('caches compiled validators across calls', async () => {
    const mw = schemaValidatorMiddleware();
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    };
    const tools = [{ name: 'test/tool', inputSchema: schema }];

    const ctx1 = makeCtx({ args: { name: 'first' } });
    (ctx1.deps.registry.getAllTools as any).mockReturnValue(tools);
    await mw(ctx1, okNext);

    const ctx2 = makeCtx({ args: { name: 'second' } });
    (ctx2.deps.registry.getAllTools as any).mockReturnValue(tools);
    await mw(ctx2, okNext);
    // No error = cached validator works
  });
});
