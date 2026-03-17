import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry } from '../src/registry/registry.js';
import { AllowlistEngine } from '../src/allowlist/engine.js';
import type { BackendAdapter } from '../src/backend/types.js';
import type { AgentConfig } from '../src/config/schema.js';
import { GatewayConfig } from '../src/config/schema.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolCallContext, ToolCallResponse } from '../src/middleware/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return GatewayConfig.parse({
    agents: { test: overrides },
  }).agents['test'];
}

function makeTool(name: string, description = 'A tool'): Tool {
  return { name, description, inputSchema: { type: 'object', properties: {} } };
}

function makeMcpAdapter(
  mcpId: string,
  tools: Tool[],
  callResult: unknown = { ok: true }
): BackendAdapter & { callSpy: ReturnType<typeof vi.fn> } {
  const callSpy = vi.fn().mockResolvedValue({ success: true, data: callResult });
  return {
    id: `mcp:${mcpId}`,
    listTools: vi.fn().mockResolvedValue(tools.map((t) => ({ ...t, name: `${mcpId}/${t.name}` }))),
    call: callSpy,
    stop: vi.fn(),
    callSpy,
  };
}

function makeCtx(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    callId: 'test',
    agentId: 'agent1',
    agentConfig: makeAgentConfig(),
    toolName: 'test/tool',
    args: {},
    meta: {} as Record<string, unknown>,
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

const okResponse: ToolCallResponse = { result: 'ok', text: 'ok' };

// ─── Tool flavor (alias) tests ───────────────────────────────────────────────

describe('Tool flavors via alias_of', () => {
  it('getFiltered includes alias tools from tool_overrides', async () => {
    const adapter = makeMcpAdapter('code', [makeTool('eval', 'Evaluate code')]);
    const agents = {
      agent1: makeAgentConfig({
        allow: ['code/*', 'sandbox-eval'],
        tool_overrides: {
          'sandbox-eval': {
            alias_of: 'code/eval',
            description: 'Evaluate code in a sandbox',
          },
        },
      }),
    };
    const allowlist = new AllowlistEngine(agents);
    const registry = new ToolRegistry([adapter], allowlist, agents);

    await registry.refresh();
    const tools = registry.getFiltered('agent1');
    const names = tools.map((t) => t.name);

    expect(names).toContain('code/eval');
    expect(names).toContain('sandbox-eval');
  });

  it('alias tools use the override description', async () => {
    const adapter = makeMcpAdapter('code', [makeTool('eval', 'Original description')]);
    const agents = {
      agent1: makeAgentConfig({
        allow: ['code/*', 'sandbox-eval'],
        tool_overrides: {
          'sandbox-eval': {
            alias_of: 'code/eval',
            description: 'Sandboxed evaluation',
          },
        },
      }),
    };
    const allowlist = new AllowlistEngine(agents);
    const registry = new ToolRegistry([adapter], allowlist, agents);

    await registry.refresh();
    const tool = registry.getFiltered('agent1').find((t) => t.name === 'sandbox-eval');
    expect(tool?.description).toBe('Sandboxed evaluation');
  });

  it('alias tools inherit base tool inputSchema', async () => {
    const baseTool: Tool = {
      name: 'eval',
      description: 'Evaluate code',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Code to evaluate' },
        },
        required: ['code'],
      },
    };
    const adapter = makeMcpAdapter('code', [baseTool]);
    const agents = {
      agent1: makeAgentConfig({
        allow: ['code/*', 'sandbox-eval'],
        tool_overrides: {
          'sandbox-eval': {
            alias_of: 'code/eval',
            description: 'Sandboxed evaluation',
          },
        },
      }),
    };
    const allowlist = new AllowlistEngine(agents);
    const registry = new ToolRegistry([adapter], allowlist, agents);

    await registry.refresh();
    const tool = registry.getFiltered('agent1').find((t) => t.name === 'sandbox-eval');
    expect(tool?.inputSchema).toEqual(baseTool.inputSchema);
  });

  it('call() resolves alias to real backend tool', async () => {
    const adapter = makeMcpAdapter('code', [makeTool('eval')], { result: 42 });
    const agents = {
      agent1: makeAgentConfig({
        allow: ['code/*', 'sandbox-eval'],
        tool_overrides: {
          'sandbox-eval': {
            alias_of: 'code/eval',
            description: 'Sandboxed evaluation',
          },
        },
      }),
    };
    const allowlist = new AllowlistEngine(agents);
    const registry = new ToolRegistry([adapter], allowlist, agents);

    await registry.refresh();
    const result = await registry.call('sandbox-eval', { code: '1+1' }, 'agent1');
    expect(result).toEqual({ result: 42 });

    // The adapter should be called with the real tool name
    expect(adapter.callSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'code/eval',
        args: { code: '1+1' },
        agentId: 'agent1',
      })
    );
  });

  it('alias is excluded when the alias itself is denied', async () => {
    const adapter = makeMcpAdapter('code', [makeTool('eval')]);
    const agents = {
      agent1: makeAgentConfig({
        allow: ['code/*'],
        deny: ['sandbox-eval'],
        tool_overrides: {
          'sandbox-eval': {
            alias_of: 'code/eval',
            description: 'Sandboxed evaluation',
          },
        },
      }),
    };
    const allowlist = new AllowlistEngine(agents);
    const registry = new ToolRegistry([adapter], allowlist, agents);

    await registry.refresh();
    const names = registry.getFiltered('agent1').map((t) => t.name);
    expect(names).toContain('code/eval');
    expect(names).not.toContain('sandbox-eval');
  });

  it('alias referencing unknown tool is skipped', async () => {
    const adapter = makeMcpAdapter('code', [makeTool('eval')]);
    const agents = {
      agent1: makeAgentConfig({
        allow: ['code/*', 'ghost-tool'],
        tool_overrides: {
          'ghost-tool': {
            alias_of: 'nonexistent/tool',
            description: 'Ghost',
          },
        },
      }),
    };
    const allowlist = new AllowlistEngine(agents);
    const registry = new ToolRegistry([adapter], allowlist, agents);

    await registry.refresh();
    const names = registry.getFiltered('agent1').map((t) => t.name);
    expect(names).not.toContain('ghost-tool');
    expect(names).toContain('code/eval');
  });

  it('alias with sandbox override is included in getFiltered', async () => {
    const adapter = makeMcpAdapter('code', [makeTool('eval')]);
    const agents = {
      agent1: makeAgentConfig({
        allow: ['code/*', 'sandbox-eval'],
        sandbox: {
          enabled: true,
          filesystem: { allow_write: ['.'], deny_read: [], deny_write: [] },
          network: { allowed_domains: [], denied_domains: [] },
          overrides: {},
        },
        tool_overrides: {
          'sandbox-eval': {
            alias_of: 'code/eval',
            description: 'Sandboxed evaluation',
            sandbox: {
              filesystem: { allow_write: ['/tmp'], deny_read: [], deny_write: [] },
            },
          },
        },
      }),
    };
    const allowlist = new AllowlistEngine(agents);
    const registry = new ToolRegistry([adapter], allowlist, agents);

    await registry.refresh();
    const names = registry.getFiltered('agent1').map((t) => t.name);
    expect(names).toContain('sandbox-eval');
    expect(names).toContain('code/eval');
  });

  it('multiple aliases of the same base tool', async () => {
    const adapter = makeMcpAdapter('code', [makeTool('eval', 'Evaluate code')]);
    const agents = {
      agent1: makeAgentConfig({
        allow: ['code/*', 'sandbox-eval', 'strict-eval'],
        tool_overrides: {
          'sandbox-eval': {
            alias_of: 'code/eval',
            description: 'Sandbox evaluation',
          },
          'strict-eval': {
            alias_of: 'code/eval',
            description: 'Strict evaluation',
          },
        },
      }),
    };
    const allowlist = new AllowlistEngine(agents);
    const registry = new ToolRegistry([adapter], allowlist, agents);

    await registry.refresh();
    const tools = registry.getFiltered('agent1');
    const names = tools.map((t) => t.name);

    expect(names).toContain('code/eval');
    expect(names).toContain('sandbox-eval');
    expect(names).toContain('strict-eval');
    expect(tools.find((t) => t.name === 'sandbox-eval')?.description).toBe('Sandbox evaluation');
    expect(tools.find((t) => t.name === 'strict-eval')?.description).toBe('Strict evaluation');
  });

  it('regular tool_overrides (no alias_of) still work for description', async () => {
    const adapter = makeMcpAdapter('github', [makeTool('create_pr', 'Original')]);
    const agents = {
      agent1: makeAgentConfig({
        allow: ['github/*'],
        tool_overrides: {
          'github/create_pr': {
            description: 'Custom PR tool',
          },
        },
      }),
    };
    const allowlist = new AllowlistEngine(agents);
    const registry = new ToolRegistry([adapter], allowlist, agents);

    await registry.refresh();
    const tool = registry.getFiltered('agent1').find((t) => t.name === 'github/create_pr');
    expect(tool?.description).toBe('Custom PR tool');
  });

  it('denied base tool alias still works if alias itself is allowed', async () => {
    const adapter = makeMcpAdapter('code', [makeTool('eval', 'Evaluate')]);
    const agents = {
      agent1: makeAgentConfig({
        allow: ['sandbox-eval'],
        deny: ['code/*'],
        tool_overrides: {
          'sandbox-eval': {
            alias_of: 'code/eval',
            description: 'Sandboxed evaluation',
          },
        },
      }),
    };
    const allowlist = new AllowlistEngine(agents);
    const registry = new ToolRegistry([adapter], allowlist, agents);

    await registry.refresh();
    const names = registry.getFiltered('agent1').map((t) => t.name);
    // Base tool is denied, but alias is allowed
    expect(names).not.toContain('code/eval');
    expect(names).toContain('sandbox-eval');
  });

  it('call() passes meta through when calling via alias', async () => {
    const adapter = makeMcpAdapter('code', [makeTool('eval')], { result: 'ok' });
    const agents = {
      agent1: makeAgentConfig({
        allow: ['code/*', 'sandbox-eval'],
        tool_overrides: {
          'sandbox-eval': {
            alias_of: 'code/eval',
          },
        },
      }),
    };
    const allowlist = new AllowlistEngine(agents);
    const registry = new ToolRegistry([adapter], allowlist, agents);

    await registry.refresh();
    const meta = { sandbox: { filesystem: { allow_write: ['/tmp'] } } };
    await registry.call('sandbox-eval', { code: 'x' }, 'agent1', meta);

    expect(adapter.callSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'code/eval',
        meta,
      })
    );
  });

  it('non-alias call works normally without resolution', async () => {
    const adapter = makeMcpAdapter('code', [makeTool('eval')], { result: 99 });
    const agents = {
      agent1: makeAgentConfig({
        allow: ['code/*'],
      }),
    };
    const allowlist = new AllowlistEngine(agents);
    const registry = new ToolRegistry([adapter], allowlist, agents);

    await registry.refresh();
    const result = await registry.call('code/eval', { code: '2+2' }, 'agent1');
    expect(result).toEqual({ result: 99 });
    expect(adapter.callSpy).toHaveBeenCalledWith(expect.objectContaining({ tool: 'code/eval' }));
  });

  it('alias without explicit description inherits base description', async () => {
    const adapter = makeMcpAdapter('code', [makeTool('eval', 'Base description')]);
    const agents = {
      agent1: makeAgentConfig({
        allow: ['code/*', 'no-desc-alias'],
        tool_overrides: {
          'no-desc-alias': {
            alias_of: 'code/eval',
          },
        },
      }),
    };
    const allowlist = new AllowlistEngine(agents);
    const registry = new ToolRegistry([adapter], allowlist, agents);

    await registry.refresh();
    const tool = registry.getFiltered('agent1').find((t) => t.name === 'no-desc-alias');
    // Without override description, should use base
    expect(tool?.description).toBe('Base description');
  });
});

// ─── Sandbox middleware with aliases ─────────────────────────────────────────

describe('Sandbox middleware with aliases', () => {
  it('sandbox middleware attaches correct config for alias calls', async () => {
    const { sandboxMiddleware } = await import('../src/middleware/core/sandbox.js');
    const { GatewayConfig: GC } = await import('../src/config/schema.js');

    const agentConfig = GC.parse({
      agents: {
        agent1: {
          allow: ['code/*', 'sandbox-eval'],
          sandbox: {
            enabled: true,
            filesystem: { allow_write: ['.', '/tmp'], deny_read: [], deny_write: [] },
            network: { allowed_domains: [], denied_domains: [] },
          },
          tool_overrides: {
            'sandbox-eval': {
              alias_of: 'code/eval',
              description: 'Sandboxed evaluation',
              sandbox: {
                filesystem: {
                  allow_write: ['/sandbox-only'],
                  deny_read: [],
                  deny_write: [],
                },
              },
            },
          },
        },
      },
    }).agents['agent1'];

    const mw = sandboxMiddleware();

    const ctx = {
      callId: 'test',
      agentId: 'agent1',
      agentConfig,
      toolName: 'sandbox-eval',
      args: {},
      meta: {} as Record<string, unknown>,
      deps: {} as any,
      startedAt: Date.now(),
    };

    let nextCalled = false;
    await mw(ctx, async () => {
      nextCalled = true;
      return { result: null, text: '' };
    });

    expect(nextCalled).toBe(true);
    expect(ctx.meta.sandbox).toBeDefined();

    const sandbox = ctx.meta.sandbox as { filesystem: { allow_write: string[] } };
    // The alias-specific sandbox override should apply
    expect(sandbox.filesystem.allow_write).toEqual(['/sandbox-only']);
  });

  it('sandbox middleware does nothing when sandbox is disabled', async () => {
    const { sandboxMiddleware } = await import('../src/middleware/core/sandbox.js');
    const { GatewayConfig: GC } = await import('../src/config/schema.js');

    const agentConfig = GC.parse({
      agents: {
        agent1: {
          allow: ['code/*'],
          sandbox: { enabled: false },
        },
      },
    }).agents['agent1'];

    const mw = sandboxMiddleware();

    const ctx = {
      callId: 'test',
      agentId: 'agent1',
      agentConfig,
      toolName: 'code/eval',
      args: {},
      meta: {} as Record<string, unknown>,
      deps: {} as any,
      startedAt: Date.now(),
    };

    await mw(ctx, async () => ({ result: null, text: '' }));
    expect(ctx.meta.sandbox).toBeUndefined();
  });

  it('sandbox middleware attaches base config for non-alias tool', async () => {
    const { sandboxMiddleware } = await import('../src/middleware/core/sandbox.js');
    const { GatewayConfig: GC } = await import('../src/config/schema.js');

    const agentConfig = GC.parse({
      agents: {
        agent1: {
          allow: ['code/*'],
          sandbox: {
            enabled: true,
            filesystem: { allow_write: ['.', '/tmp'], deny_read: [], deny_write: [] },
            network: { allowed_domains: ['api.com'], denied_domains: [] },
          },
        },
      },
    }).agents['agent1'];

    const mw = sandboxMiddleware();

    const ctx = {
      callId: 'test',
      agentId: 'agent1',
      agentConfig,
      toolName: 'code/eval',
      args: {},
      meta: {} as Record<string, unknown>,
      deps: {} as any,
      startedAt: Date.now(),
    };

    await mw(ctx, async () => ({ result: null, text: '' }));
    expect(ctx.meta.sandbox).toBeDefined();

    const sandbox = ctx.meta.sandbox as {
      filesystem: { allow_write: string[] };
      network: { allowed_domains: string[] };
    };
    expect(sandbox.filesystem.allow_write).toEqual(['.', '/tmp']);
    expect(sandbox.network.allowed_domains).toEqual(['api.com']);
  });

  it('sandbox disabled even for alias with sandbox override', async () => {
    const { sandboxMiddleware } = await import('../src/middleware/core/sandbox.js');
    const { GatewayConfig: GC } = await import('../src/config/schema.js');

    const agentConfig = GC.parse({
      agents: {
        agent1: {
          allow: ['code/*', 'sandbox-eval'],
          sandbox: { enabled: false },
          tool_overrides: {
            'sandbox-eval': {
              alias_of: 'code/eval',
              sandbox: {
                filesystem: { allow_write: ['/sandbox'] },
              },
            },
          },
        },
      },
    }).agents['agent1'];

    const mw = sandboxMiddleware();

    const ctx = {
      callId: 'test',
      agentId: 'agent1',
      agentConfig,
      toolName: 'sandbox-eval',
      args: {},
      meta: {} as Record<string, unknown>,
      deps: {} as any,
      startedAt: Date.now(),
    };

    await mw(ctx, async () => ({ result: null, text: '' }));
    // Sandbox is disabled at agent level, so no sandbox config should be set
    expect(ctx.meta.sandbox).toBeUndefined();
  });
});

// ─── Allowlist evaluation with aliases ───────────────────────────────────────

describe('Allowlist with aliases', () => {
  it('allow sandbox-eval, ask eval', () => {
    const agents = {
      agent1: makeAgentConfig({
        allow: ['sandbox-eval'],
        ask: ['code/*'],
      }),
    };
    const allowlist = new AllowlistEngine(agents);

    expect(allowlist.evaluate('agent1', 'sandbox-eval')).toBe('allow');
    expect(allowlist.evaluate('agent1', 'code/eval')).toBe('ask');
  });

  it('deny takes precedence over allow for alias', () => {
    const agents = {
      agent1: makeAgentConfig({
        allow: ['sandbox-eval', 'code/*'],
        deny: ['sandbox-eval'],
      }),
    };
    const allowlist = new AllowlistEngine(agents);

    expect(allowlist.evaluate('agent1', 'sandbox-eval')).toBe('deny');
    expect(allowlist.evaluate('agent1', 'code/eval')).toBe('allow');
  });

  it('alias in ask list requires approval', () => {
    const agents = {
      agent1: makeAgentConfig({
        allow: ['code/*'],
        ask: ['sandbox-eval'],
      }),
    };
    const allowlist = new AllowlistEngine(agents);

    expect(allowlist.evaluate('agent1', 'sandbox-eval')).toBe('ask');
    expect(allowlist.evaluate('agent1', 'code/eval')).toBe('allow');
  });

  it('base allowed, alias denied — alias is blocked', () => {
    const agents = {
      agent1: makeAgentConfig({
        allow: ['code/*'],
        deny: ['sandbox-eval'],
      }),
    };
    const allowlist = new AllowlistEngine(agents);

    expect(allowlist.evaluate('agent1', 'code/eval')).toBe('allow');
    expect(allowlist.evaluate('agent1', 'sandbox-eval')).toBe('deny');
  });

  it('base denied, alias allowed — alias works', () => {
    const agents = {
      agent1: makeAgentConfig({
        allow: ['sandbox-eval'],
        deny: ['code/*'],
      }),
    };
    const allowlist = new AllowlistEngine(agents);

    expect(allowlist.evaluate('agent1', 'code/eval')).toBe('deny');
    expect(allowlist.evaluate('agent1', 'sandbox-eval')).toBe('allow');
  });

  it('neither base nor alias in any list — default deny', () => {
    const agents = {
      agent1: makeAgentConfig({
        allow: ['other/*'],
      }),
    };
    const allowlist = new AllowlistEngine(agents);

    expect(allowlist.evaluate('agent1', 'code/eval')).toBe('deny');
    expect(allowlist.evaluate('agent1', 'sandbox-eval')).toBe('deny');
  });

  it('wildcard allow covers alias if it matches the pattern', () => {
    const agents = {
      agent1: makeAgentConfig({
        allow: ['sandbox*'],
      }),
    };
    const allowlist = new AllowlistEngine(agents);

    expect(allowlist.evaluate('agent1', 'sandbox-eval')).toBe('allow');
    expect(allowlist.evaluate('agent1', 'sandbox-strict')).toBe('allow');
    expect(allowlist.evaluate('agent1', 'code/eval')).toBe('deny');
  });
});
