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
    (ctx.deps.registry.getAllTools as any).mockReturnValue([
      {
        name: 'test/tool',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            count: { type: 'number' },
          },
          required: ['name'],
        },
      },
    ]);
    const result = await mw(ctx, okNext);
    expect(result.text).toBe('ok');
  });

  it('rejects missing required field', async () => {
    const mw = schemaValidatorMiddleware();
    const ctx = makeCtx({ args: {} });
    (ctx.deps.registry.getAllTools as any).mockReturnValue([
      {
        name: 'test/tool',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
      },
    ]);
    await expect(mw(ctx, okNext)).rejects.toThrow('Invalid arguments');
  });

  it('rejects wrong type', async () => {
    const mw = schemaValidatorMiddleware();
    const ctx = makeCtx({ args: { name: 123 } });
    (ctx.deps.registry.getAllTools as any).mockReturnValue([
      {
        name: 'test/tool',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
      },
    ]);
    await expect(mw(ctx, okNext)).rejects.toThrow('Invalid arguments');
  });

  it('passes when tool not found in registry', async () => {
    const mw = schemaValidatorMiddleware();
    const ctx = makeCtx({ toolName: 'unknown/tool' });
    const result = await mw(ctx, okNext);
    expect(result.text).toBe('ok');
  });

  it('validates aliases against the base tool schema', async () => {
    const mw = schemaValidatorMiddleware();
    const ctx = makeCtx({
      toolName: 'python/sandboxed',
      args: {},
      agentConfig: {
        tool_overrides: {
          'python/sandboxed': { alias_of: 'exec/run' },
        },
      } as any,
    });
    (ctx.deps.registry.getAllTools as any).mockReturnValue([
      {
        name: 'exec/run',
        inputSchema: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
    ]);

    await expect(mw(ctx, okNext)).rejects.toThrow('Invalid arguments');
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

  it('compiles draft 2020-12 and 2019-09 schemas (including URI variants) and isolates duplicate $id across refreshes', async () => {
    const mw = schemaValidatorMiddleware();
    const schema1 = {
      $schema: 'https://json-schema.org/draft/2020-12/schema#',
      $id: 'urn:airlock:test:dup',
      $defs: { tag: { type: 'string' } },
      type: 'object',
      properties: {
        a: { $ref: '#/$defs/tag' },
        pair: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }] },
      },
      required: ['a'],
    };
    const schema2 = {
      $schema: 'http://json-schema.org/draft/2020-12/schema',
      $id: 'urn:airlock:test:dup',
      type: 'object',
      properties: { b: { type: 'number' } },
      required: ['b'],
    };
    const schema2019 = {
      $schema: 'https://json-schema.org/draft/2019-09/schema#',
      $id: 'urn:airlock:test:dup',
      type: 'object',
      properties: { c: { type: 'boolean' } },
      required: ['c'],
    };

    const ctx1 = makeCtx({ args: { a: 'ok', pair: ['x', 1] } });
    (ctx1.deps.registry.getAllTools as any).mockReturnValue([
      { name: 'test/tool', inputSchema: schema1 },
    ]);
    await expect(mw(ctx1, okNext)).resolves.toEqual(okResponse);

    const ctx1Bad = makeCtx({ args: { a: 'ok', pair: [123, 'bad'] } });
    (ctx1Bad.deps.registry.getAllTools as any).mockReturnValue([
      { name: 'test/tool', inputSchema: schema1 },
    ]);
    await expect(mw(ctx1Bad, okNext)).rejects.toThrow('Invalid arguments');

    const ctx2 = makeCtx({ args: { b: 42 } });
    (ctx2.deps.registry.getAllTools as any).mockReturnValue([
      { name: 'test/tool', inputSchema: schema2 },
    ]);
    await expect(mw(ctx2, okNext)).resolves.toEqual(okResponse);

    const ctx3 = makeCtx({ args: { a: 'ok' } });
    (ctx3.deps.registry.getAllTools as any).mockReturnValue([
      { name: 'test/tool', inputSchema: schema2 },
    ]);
    await expect(mw(ctx3, okNext)).rejects.toThrow('Invalid arguments');

    const ctx4 = makeCtx({ args: { c: true } });
    (ctx4.deps.registry.getAllTools as any).mockReturnValue([
      { name: 'test/tool', inputSchema: schema2019 },
    ]);
    await expect(mw(ctx4, okNext)).resolves.toEqual(okResponse);
  });
});
