import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry } from '../src/registry/registry.js';
import { AllowlistEngine } from '../src/allowlist/engine.js';
import { GatewayConfig } from '../src/config/schema.js';
import type { BackendAdapter } from '../src/backend/types.js';
import { ErrorCode, McpError, type Tool } from '@modelcontextprotocol/sdk/types.js';

function makeAgentConfig(overrides: Record<string, unknown> = {}) {
  return GatewayConfig.parse({
    agents: {
      agent: {
        allow: ['*'],
        ...overrides,
      },
    },
  }).agents.agent;
}

function adapter(id: string, tools: Tool[]): BackendAdapter {
  return {
    id,
    listTools: vi.fn().mockResolvedValue(tools),
    call: vi.fn(),
    stop: vi.fn(),
  };
}

describe('MCP proxy registry correctness', () => {
  it('emits a catalog change only when the effective tool definitions change', async () => {
    const agents = { agent: makeAgentConfig() };
    const source = adapter('mcp:provider', [
      { name: 'provider/read', inputSchema: { type: 'object' } },
    ]);
    const registry = new ToolRegistry([source], new AllowlistEngine(agents), agents);
    const changed = vi.fn();
    registry.onToolsChanged(changed);

    await registry.refresh();
    await registry.refresh();

    expect(changed).toHaveBeenCalledTimes(1);
    (source.listTools as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 'provider/read', inputSchema: { type: 'object' } },
      { name: 'provider/write', inputSchema: { type: 'object' } },
    ]);
    await registry.refresh();
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('emits a catalog change when agent visibility policy changes', () => {
    const agents = { agent: makeAgentConfig() };
    const registry = new ToolRegistry([], new AllowlistEngine(agents), agents);
    const changed = vi.fn();
    registry.onToolsChanged(changed);

    registry.reloadAgents(agents);
    expect(changed).not.toHaveBeenCalled();

    registry.reloadAgents({ agent: makeAgentConfig({ allow: ['provider/read'] }) });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('filters required task tools while preserving other tool fields', async () => {
    const tool: Tool = {
      name: 'provider/optional',
      description: 'Optional task tool',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
      outputSchema: { type: 'object', properties: { result: { type: 'string' } } },
      execution: { taskSupport: 'optional' },
      annotations: { readOnlyHint: true },
      _meta: { source: 'upstream' },
    };
    const required: Tool = {
      name: 'provider/required',
      description: 'Cannot be proxied without tasks',
      inputSchema: { type: 'object' },
      execution: { taskSupport: 'required' },
    };
    const agents = { agent: makeAgentConfig() };
    const source = adapter('mcp:provider', [tool, required]);
    const registry = new ToolRegistry([source], new AllowlistEngine(agents), agents);

    await registry.refresh();

    expect(registry.getAllTools()).toEqual([tool]);
    expect(registry.getAllTools().map((entry) => entry.name)).not.toContain('provider/required');
    await expect(registry.call('provider/required', {}, 'agent')).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
    });
    expect(source.call).not.toHaveBeenCalled();
  });

  it('rejects duplicate internal names instead of silently routing one', async () => {
    const agents = { agent: makeAgentConfig() };
    const registry = new ToolRegistry(
      [
        adapter('mcp:first', [{ name: 'shared/tool', inputSchema: { type: 'object' } }]),
        adapter('mcp:second', [{ name: 'shared/tool', inputSchema: { type: 'object' } }]),
      ],
      new AllowlistEngine(agents),
      agents
    );

    await expect(registry.refresh()).rejects.toThrow(/tool name collision/i);
  });

  it('preserves typed downstream MCP protocol errors', async () => {
    const agents = { agent: makeAgentConfig() };
    const failure = new McpError(ErrorCode.InvalidParams, 'bad upstream arguments', {
      field: 'query',
    });
    const source = adapter('mcp:provider', [
      { name: 'provider/read', inputSchema: { type: 'object' } },
    ]);
    source.call = vi.fn().mockResolvedValue({
      success: false,
      error: failure.message,
      cause: failure,
    });
    const registry = new ToolRegistry([source], new AllowlistEngine(agents), agents);
    await registry.refresh();

    await expect(registry.call('provider/read', {}, 'agent')).rejects.toBe(failure);
  });

  it('rejects names that collide after the agent-facing namespace mapping', async () => {
    const agents = { agent: makeAgentConfig() };
    const registry = new ToolRegistry(
      [
        adapter('mcp:provider', [
          { name: 'provider/one', inputSchema: { type: 'object' } },
          { name: 'provider_one', inputSchema: { type: 'object' } },
        ]),
      ],
      new AllowlistEngine(agents),
      agents
    );

    await expect(registry.refresh()).rejects.toThrow(/agent-facing tool name collision/i);
  });

  it('rejects aliases that collide with another visible agent-facing name', async () => {
    const agents = {
      agent: makeAgentConfig({
        tool_overrides: {
          provider_one: { alias_of: 'provider/one' },
        },
      }),
    };
    const registry = new ToolRegistry(
      [adapter('mcp:provider', [{ name: 'provider/one', inputSchema: { type: 'object' } }])],
      new AllowlistEngine(agents),
      agents
    );

    await registry.refresh();
    expect(() => registry.getFiltered('agent')).toThrow(/agent-facing tool name collision/i);
  });

  it('rejects two adapters that claim the same call namespace', () => {
    const agents = { agent: makeAgentConfig() };

    expect(
      () =>
        new ToolRegistry(
          [adapter('mcp:provider', []), adapter('cli:provider', [])],
          new AllowlistEngine(agents),
          agents
        )
    ).toThrow(/adapter namespace collision/i);
  });
});
