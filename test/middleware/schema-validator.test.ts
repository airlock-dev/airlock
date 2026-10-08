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

  it("uses MCP's default JSON Schema 2020-12 dialect", async () => {
    const mw = schemaValidatorMiddleware();
    const ctx = makeCtx({ toolName: 'test/default-2020', args: { name: 'test', extra: true } });
    (ctx.deps.registry.getAllTools as any).mockReturnValue([
      {
        name: 'test/default-2020',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
          unevaluatedProperties: false,
        },
      },
    ]);

    await expect(mw(ctx, okNext)).rejects.toThrow('Invalid arguments');
  });

  it('supports an explicit JSON Schema 2020-12 dialect', async () => {
    const mw = schemaValidatorMiddleware();
    const ctx = makeCtx({ toolName: 'test/explicit-2020', args: { name: 'test', extra: true } });
    (ctx.deps.registry.getAllTools as any).mockReturnValue([
      {
        name: 'test/explicit-2020',
        inputSchema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
          unevaluatedProperties: false,
        },
      },
    ]);

    await expect(mw(ctx, okNext)).rejects.toThrow('Invalid arguments');
  });

  it('supports an explicit JSON Schema 2019-09 dialect', async () => {
    const mw = schemaValidatorMiddleware();
    const ctx = makeCtx({ toolName: 'test/explicit-2019', args: { name: 'test', extra: true } });
    (ctx.deps.registry.getAllTools as any).mockReturnValue([
      {
        name: 'test/explicit-2019',
        inputSchema: {
          $schema: 'https://json-schema.org/draft/2019-09/schema',
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
          unevaluatedProperties: false,
        },
      },
    ]);

    await expect(mw(ctx, okNext)).rejects.toThrow('Invalid arguments');
  });

  it('preserves explicit draft-07 validation', async () => {
    const mw = schemaValidatorMiddleware();
    const ctx = makeCtx({ toolName: 'test/draft-07', args: { name: 'test', extra: true } });
    (ctx.deps.registry.getAllTools as any).mockReturnValue([
      {
        name: 'test/draft-07',
        inputSchema: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
          additionalProperties: false,
        },
      },
    ]);

    await expect(mw(ctx, okNext)).rejects.toThrow('Invalid arguments');
  });

  it('validates structured tool output against the full aggregated tool definition', async () => {
    const mw = schemaValidatorMiddleware();
    const ctx = makeCtx({ toolName: 'test/structured-output' });
    (ctx.deps.registry.getAllTools as any).mockReturnValue([
      {
        name: 'test/structured-output',
        inputSchema: { type: 'object' },
        outputSchema: {
          type: 'object',
          properties: { status: { const: 'ok' } },
          required: ['status'],
          unevaluatedProperties: false,
        },
      },
    ]);

    await expect(
      mw(ctx, async () => ({
        result: {
          content: [{ type: 'text', text: '{"status":"wrong"}' }],
          structuredContent: { status: 'wrong' },
        },
        text: '{"status":"wrong"}',
      }))
    ).rejects.toThrow('Invalid structured output');
  });

  it('requires structured content for successful tools with an output schema', async () => {
    const mw = schemaValidatorMiddleware();
    const ctx = makeCtx({ toolName: 'test/missing-structured-output' });
    (ctx.deps.registry.getAllTools as any).mockReturnValue([
      {
        name: 'test/missing-structured-output',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
      },
    ]);

    await expect(
      mw(ctx, async () => ({
        result: { content: [{ type: 'text', text: 'missing' }] },
        text: 'missing',
      }))
    ).rejects.toThrow('returned no structured content');
  });

  it('does not require structured content for tool execution errors', async () => {
    const mw = schemaValidatorMiddleware();
    const ctx = makeCtx({ toolName: 'test/error-output' });
    (ctx.deps.registry.getAllTools as any).mockReturnValue([
      {
        name: 'test/error-output',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
      },
    ]);
    const response: ToolCallResponse = {
      result: { content: [{ type: 'text', text: 'failed' }], isError: true },
      text: 'failed',
    };

    await expect(mw(ctx, async () => response)).resolves.toBe(response);
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
});
