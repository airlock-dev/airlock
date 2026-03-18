import { describe, it, expect, vi } from 'vitest';
import { sandboxMiddleware } from '../src/middleware/core/sandbox.js';
import { compose } from '../src/middleware/compose.js';
import type { ToolCallContext, ToolCallResponse, Middleware } from '../src/middleware/types.js';
import type { AgentConfig } from '../src/config/schema.js';
import { GatewayConfig } from '../src/config/schema.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const okResponse: ToolCallResponse = { result: 'ok', text: 'ok' };
const okNext = async () => okResponse;

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return GatewayConfig.parse({
    agents: { test: overrides },
  }).agents['test'];
}

function makeCtx(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    callId: 'test',
    agentId: 'agent1',
    agentConfig: makeAgentConfig(),
    toolName: 'code/eval',
    args: {},
    meta: {} as Record<string, unknown>,
    deps: {
      registry: {
        call: vi.fn().mockResolvedValue({ content: [] }),
      } as any,
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

// ─── Sandbox middleware unit tests ───────────────────────────────────────────

describe('sandboxMiddleware', () => {
  it('attaches base sandbox config when enabled and no overrides match', async () => {
    const mw = sandboxMiddleware();
    const ctx = makeCtx({
      agentConfig: makeAgentConfig({
        sandbox: {
          enabled: true,
          filesystem: { allow_write: ['/project'], deny_read: ['/secret'], deny_write: ['/sys'] },
          network: { allowed_domains: ['api.com'], denied_domains: ['evil.com'] },
        },
      }),
    });

    await mw(ctx, okNext);

    expect(ctx.meta.sandbox).toBeDefined();
    const sandbox = ctx.meta.sandbox as {
      filesystem: { allow_write: string[]; deny_read: string[]; deny_write: string[] };
      network: { allowed_domains: string[]; denied_domains: string[] };
    };
    expect(sandbox.filesystem.allow_write).toEqual(['/project']);
    expect(sandbox.filesystem.deny_read).toEqual(['/secret']);
    expect(sandbox.network.allowed_domains).toEqual(['api.com']);
  });

  it('does not attach sandbox config when disabled', async () => {
    const mw = sandboxMiddleware();
    const ctx = makeCtx({
      agentConfig: makeAgentConfig({
        sandbox: { enabled: false },
      }),
    });

    await mw(ctx, okNext);
    expect(ctx.meta.sandbox).toBeUndefined();
  });

  it('attaches merged config when enabled with matching override', async () => {
    const mw = sandboxMiddleware();
    const ctx = makeCtx({
      toolName: 'github/create_pr',
      agentConfig: makeAgentConfig({
        sandbox: {
          enabled: true,
          filesystem: { allow_write: ['.'], deny_read: ['/base-secret'], deny_write: [] },
          network: { allowed_domains: ['base.com'], denied_domains: [] },
          overrides: {
            'github/*': {
              filesystem: { deny_read: ['/github-secret'] },
              network: { allowed_domains: ['github.com'] },
            },
          },
        },
      }),
    });

    await mw(ctx, okNext);

    const sandbox = ctx.meta.sandbox as {
      filesystem: { deny_read: string[] };
      network: { allowed_domains: string[] };
    };
    // deny_read is additive
    expect(sandbox.filesystem.deny_read).toEqual(['/base-secret', '/github-secret']);
    // allowed_domains replaces
    expect(sandbox.network.allowed_domains).toEqual(['github.com']);
  });

  it('attaches base config when enabled but override does not match', async () => {
    const mw = sandboxMiddleware();
    const ctx = makeCtx({
      toolName: 'slack/post',
      agentConfig: makeAgentConfig({
        sandbox: {
          enabled: true,
          filesystem: { allow_write: ['/base'], deny_read: [], deny_write: [] },
          network: { allowed_domains: ['base.com'], denied_domains: [] },
          overrides: {
            'github/*': {
              filesystem: { allow_write: ['/github'] },
            },
          },
        },
      }),
    });

    await mw(ctx, okNext);

    const sandbox = ctx.meta.sandbox as {
      filesystem: { allow_write: string[] };
      network: { allowed_domains: string[] };
    };
    expect(sandbox.filesystem.allow_write).toEqual(['/base']);
    expect(sandbox.network.allowed_domains).toEqual(['base.com']);
  });

  it('always calls next()', async () => {
    const mw = sandboxMiddleware();
    let nextCalled = false;

    // Test with sandbox enabled
    const ctx1 = makeCtx({
      agentConfig: makeAgentConfig({
        sandbox: { enabled: true },
      }),
    });
    await mw(ctx1, async () => {
      nextCalled = true;
      return okResponse;
    });
    expect(nextCalled).toBe(true);

    // Test with sandbox disabled
    nextCalled = false;
    const ctx2 = makeCtx({
      agentConfig: makeAgentConfig({
        sandbox: { enabled: false },
      }),
    });
    await mw(ctx2, async () => {
      nextCalled = true;
      return okResponse;
    });
    expect(nextCalled).toBe(true);
  });

  it('returns whatever next() returns', async () => {
    const mw = sandboxMiddleware();
    const customResponse: ToolCallResponse = { result: { data: 42 }, text: 'custom' };
    const ctx = makeCtx({
      agentConfig: makeAgentConfig({ sandbox: { enabled: true } }),
    });

    const result = await mw(ctx, async () => customResponse);
    expect(result).toBe(customResponse);
  });

  it('does not set sandbox when agentConfig is missing sandbox section', async () => {
    const mw = sandboxMiddleware();
    // Default agent config has sandbox.enabled = false
    const ctx = makeCtx();

    await mw(ctx, okNext);
    expect(ctx.meta.sandbox).toBeUndefined();
  });

  it('uses tool_overrides sandbox for the matching tool', async () => {
    const mw = sandboxMiddleware();
    const ctx = makeCtx({
      toolName: 'sandbox-eval',
      agentConfig: makeAgentConfig({
        sandbox: {
          enabled: true,
          filesystem: { allow_write: ['.', '/tmp'], deny_read: [], deny_write: [] },
          network: { allowed_domains: [], denied_domains: [] },
        },
        tool_overrides: {
          'sandbox-eval': {
            alias_of: 'code/eval',
            sandbox: {
              filesystem: { allow_write: ['/sandbox-only'] },
            },
          },
        },
      }),
    });

    await mw(ctx, okNext);

    const sandbox = ctx.meta.sandbox as { filesystem: { allow_write: string[] } };
    expect(sandbox.filesystem.allow_write).toEqual(['/sandbox-only']);
    expect(ctx.meta.sandbox_info).toMatchObject({
      presets: [],
      toolPresets: [],
      summary: expect.arrayContaining(['network:none', 'write:/sandbox-only']),
    });
  });

  it('includes preset names in sandbox display info', async () => {
    const mw = sandboxMiddleware();
    const ctx = makeCtx({
      toolName: 'python/sandboxed',
      agentConfig: makeAgentConfig({
        sandbox: {
          enabled: true,
          presets: ['local_transform'],
          filesystem: { allow_write: ['/tmp'], deny_read: [], deny_write: ['.'] },
          network: { allowed_domains: [], denied_domains: [] },
        },
        tool_overrides: {
          'python/sandboxed': {
            alias_of: 'exec/run',
            sandbox_presets: ['github_networked'],
            sandbox: {
              network: { allowed_domains: ['api.github.com'] },
            },
          },
        },
      }),
    });

    await mw(ctx, okNext);

    expect(ctx.meta.sandbox_info).toMatchObject({
      presets: ['local_transform'],
      toolPresets: ['github_networked'],
      summary: expect.arrayContaining(['network:api.github.com']),
    });
  });

  it('ignores tool_overrides sandbox for non-matching tool', async () => {
    const mw = sandboxMiddleware();
    const ctx = makeCtx({
      toolName: 'code/eval',
      agentConfig: makeAgentConfig({
        sandbox: {
          enabled: true,
          filesystem: { allow_write: ['.', '/tmp'], deny_read: [], deny_write: [] },
          network: { allowed_domains: [], denied_domains: [] },
        },
        tool_overrides: {
          'sandbox-eval': {
            alias_of: 'code/eval',
            sandbox: {
              filesystem: { allow_write: ['/sandbox-only'] },
            },
          },
        },
      }),
    });

    await mw(ctx, okNext);

    const sandbox = ctx.meta.sandbox as { filesystem: { allow_write: string[] } };
    // 'code/eval' is not in tool_overrides, so base config applies
    expect(sandbox.filesystem.allow_write).toEqual(['.', '/tmp']);
  });
});

// ─── Chain position verification ─────────────────────────────────────────────

describe('sandboxMiddleware chain position', () => {
  it('sandbox middleware runs before execute in compose order', async () => {
    const order: string[] = [];

    const sandboxMw = sandboxMiddleware();

    const wrappedSandbox: Middleware = async (ctx, next) => {
      order.push('sandbox-before');
      const result = await sandboxMw(ctx, next);
      order.push('sandbox-after');
      return result;
    };

    const executeMw: Middleware = async (ctx, _next) => {
      order.push('execute');
      return { result: ctx.meta, text: 'done' };
    };

    const chain = compose([wrappedSandbox, executeMw]);
    const ctx = makeCtx({
      agentConfig: makeAgentConfig({
        sandbox: { enabled: true },
      }),
    });

    await chain(ctx, async () => okResponse);

    expect(order).toEqual(['sandbox-before', 'execute', 'sandbox-after']);
  });

  it('sandbox config is available on ctx.meta when execute runs', async () => {
    const sandboxMw = sandboxMiddleware();
    let metaSandboxAtExecute: unknown = undefined;

    const executeMw: Middleware = async (ctx, _next) => {
      metaSandboxAtExecute = ctx.meta.sandbox;
      return { result: null, text: '' };
    };

    const chain = compose([sandboxMw, executeMw]);
    const ctx = makeCtx({
      agentConfig: makeAgentConfig({
        sandbox: {
          enabled: true,
          filesystem: { allow_write: ['/test'], deny_read: [], deny_write: [] },
          network: { allowed_domains: [], denied_domains: [] },
        },
      }),
    });

    await chain(ctx, okNext);

    expect(metaSandboxAtExecute).toBeDefined();
    const sandbox = metaSandboxAtExecute as { filesystem: { allow_write: string[] } };
    expect(sandbox.filesystem.allow_write).toEqual(['/test']);
  });

  it('sandbox config absent on ctx.meta when disabled and execute runs', async () => {
    const sandboxMw = sandboxMiddleware();
    let metaSandboxAtExecute: unknown = 'SENTINEL';

    const executeMw: Middleware = async (ctx, _next) => {
      metaSandboxAtExecute = ctx.meta.sandbox;
      return { result: null, text: '' };
    };

    const chain = compose([sandboxMw, executeMw]);
    const ctx = makeCtx({
      agentConfig: makeAgentConfig({
        sandbox: { enabled: false },
      }),
    });

    await chain(ctx, okNext);
    expect(metaSandboxAtExecute).toBeUndefined();
  });
});

// ─── Edge cases ──────────────────────────────────────────────────────────────

describe('sandboxMiddleware edge cases', () => {
  it('handles agentConfig with no sandbox config at all (defaults)', async () => {
    const mw = sandboxMiddleware();
    const ctx = makeCtx({
      agentConfig: makeAgentConfig(),
    });

    await mw(ctx, okNext);
    // Default sandbox is disabled
    expect(ctx.meta.sandbox).toBeUndefined();
  });

  it('handles sandbox.enabled: false everywhere', async () => {
    const mw = sandboxMiddleware();
    const ctx = makeCtx({
      agentConfig: makeAgentConfig({
        sandbox: {
          enabled: false,
          filesystem: { allow_write: ['/should-not-matter'] },
        },
      }),
    });

    await mw(ctx, okNext);
    expect(ctx.meta.sandbox).toBeUndefined();
  });

  it('handles empty overrides map', async () => {
    const mw = sandboxMiddleware();
    const ctx = makeCtx({
      agentConfig: makeAgentConfig({
        sandbox: {
          enabled: true,
          overrides: {},
        },
      }),
    });

    await mw(ctx, okNext);
    expect(ctx.meta.sandbox).toBeDefined();
  });

  it('handles meta: {} (pre-initialized empty meta)', async () => {
    const mw = sandboxMiddleware();
    const ctx = makeCtx({
      meta: {},
      agentConfig: makeAgentConfig({
        sandbox: { enabled: true },
      }),
    });

    await mw(ctx, okNext);
    expect(ctx.meta.sandbox).toBeDefined();
  });

  it('handles tool_overrides with no sandbox field', async () => {
    const mw = sandboxMiddleware();
    const ctx = makeCtx({
      toolName: 'custom-tool',
      agentConfig: makeAgentConfig({
        sandbox: {
          enabled: true,
          filesystem: { allow_write: ['.'], deny_read: [], deny_write: [] },
          network: { allowed_domains: [], denied_domains: [] },
        },
        tool_overrides: {
          'custom-tool': {
            description: 'Just a description override',
          },
        },
      }),
    });

    await mw(ctx, okNext);
    const sandbox = ctx.meta.sandbox as { filesystem: { allow_write: string[] } };
    // No tool-specific sandbox override, so base config applies
    expect(sandbox.filesystem.allow_write).toEqual(['.']);
  });

  it('does not crash with undefined agentConfig sandbox', async () => {
    const mw = sandboxMiddleware();
    // Manually create context where agentConfig has no sandbox property
    const ctx: ToolCallContext = {
      callId: 'test',
      agentId: 'agent1',
      agentConfig: {
        allow: [],
        ask: [],
        deny: [],
        tool_overrides: {},
        exec: { allow: [], ask: [], deny: [], env: {}, default_timeout_ms: 5000 },
        http: { domain_allowlist: [], max_response_bytes: 1048576, timeout_ms: 5000 },
      } as AgentConfig,
      toolName: 'test/tool',
      args: {},
      meta: {},
      deps: {} as any,
      startedAt: Date.now(),
    };

    // Should not throw
    await mw(ctx, okNext);
    expect(ctx.meta.sandbox).toBeUndefined();
  });
});
