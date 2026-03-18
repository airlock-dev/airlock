import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ClientPool } from '../src/pool/pool.js';
import type { McpServerConfig } from '../src/config/schema.js';
import type { ResolvedSandboxConfig } from '../src/sandbox/index.js';

// Mock sandbox-runtime
vi.mock('@anthropic-ai/sandbox-runtime', () => ({
  SandboxManager: {
    wrapWithSandbox: vi
      .fn()
      .mockImplementation((cmd: string) => Promise.resolve(`sandbox-wrap(${cmd})`)),
  },
}));

// Mock MCP SDK transports and client
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockCallTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'result' }] });
const mockTransportClose = vi.fn().mockResolvedValue(undefined);

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    callTool: mockCallTool,
  })),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({
    close: mockTransportClose,
  })),
}));

function makePool(overrides: Partial<ClientPool> = {}): ClientPool {
  return {
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn().mockResolvedValue({ content: [] }),
    getMcpIds: vi.fn().mockReturnValue([]),
    stop: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ClientPool;
}

const stdioConfig: McpServerConfig = {
  type: 'stdio',
  command: 'node',
  args: ['server.js'],
};

const sseConfig: McpServerConfig = {
  type: 'sse',
  url: 'https://example.com/sse',
};

const baseSandbox: ResolvedSandboxConfig = {
  filesystem: {
    allow_write: ['/tmp'],
    deny_read: ['/secret'],
    deny_write: ['/sys'],
  },
  network: {
    allowed_domains: ['api.com'],
    denied_domains: ['evil.com'],
  },
};

describe('McpBackendAdapter sandbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses pool for call without sandbox config', async () => {
    const { McpBackendAdapter } = await import('../src/backend/mcp-adapter.js');

    const pool = makePool({
      callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'pool result' }] }),
    });
    const adapter = new McpBackendAdapter('github', pool, stdioConfig);

    const result = await adapter.call({
      tool: 'github/create_pr',
      args: { repo: 'test' },
      agentId: 'agent1',
    });

    expect(result.success).toBe(true);
    expect(pool.callTool).toHaveBeenCalledWith('github', 'create_pr', { repo: 'test' });
  });

  it('uses pool for call with empty meta', async () => {
    const { McpBackendAdapter } = await import('../src/backend/mcp-adapter.js');

    const pool = makePool({
      callTool: vi.fn().mockResolvedValue({ content: [] }),
    });
    const adapter = new McpBackendAdapter('github', pool, stdioConfig);

    const result = await adapter.call({
      tool: 'github/create_pr',
      args: {},
      agentId: 'agent1',
      meta: {},
    });

    expect(result.success).toBe(true);
    expect(pool.callTool).toHaveBeenCalled();
  });

  it('uses pool for call with meta.sandbox undefined', async () => {
    const { McpBackendAdapter } = await import('../src/backend/mcp-adapter.js');

    const pool = makePool({
      callTool: vi.fn().mockResolvedValue({ content: [] }),
    });
    const adapter = new McpBackendAdapter('github', pool, stdioConfig);

    const result = await adapter.call({
      tool: 'github/create_pr',
      args: {},
      agentId: 'agent1',
      meta: { sandbox: undefined },
    });

    expect(result.success).toBe(true);
    expect(pool.callTool).toHaveBeenCalled();
  });

  it('spawns ephemeral sandboxed instance for stdio with sandbox config', async () => {
    const { McpBackendAdapter } = await import('../src/backend/mcp-adapter.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    const pool = makePool();
    const adapter = new McpBackendAdapter('github', pool, stdioConfig);

    const result = await adapter.call({
      tool: 'github/create_pr',
      args: { repo: 'test' },
      agentId: 'agent1',
      meta: { sandbox: baseSandbox },
    });

    expect(result.success).toBe(true);
    // Pool should NOT be used
    expect(pool.callTool).not.toHaveBeenCalled();
    // Ephemeral transport should be created
    expect(StdioClientTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        command: '/bin/sh',
        args: ['-c', 'sandbox-wrap(node server.js)'],
      })
    );
    // Client should connect and call tool
    expect(mockConnect).toHaveBeenCalled();
    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'create_pr',
      arguments: { repo: 'test' },
    });
  });

  it('tears down ephemeral transport after successful call', async () => {
    const { McpBackendAdapter } = await import('../src/backend/mcp-adapter.js');

    const pool = makePool();
    const adapter = new McpBackendAdapter('github', pool, stdioConfig);

    await adapter.call({
      tool: 'github/create_pr',
      args: {},
      agentId: 'agent1',
      meta: { sandbox: baseSandbox },
    });

    expect(mockTransportClose).toHaveBeenCalled();
  });

  it('tears down ephemeral transport on error', async () => {
    const { McpBackendAdapter } = await import('../src/backend/mcp-adapter.js');

    mockCallTool.mockRejectedValueOnce(new Error('tool failed'));

    const pool = makePool();
    const adapter = new McpBackendAdapter('github', pool, stdioConfig);

    const result = await adapter.call({
      tool: 'github/create_pr',
      args: {},
      agentId: 'agent1',
      meta: { sandbox: baseSandbox },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('tool failed');
    // Transport should still be closed in finally block
    expect(mockTransportClose).toHaveBeenCalled();
  });

  it('strips tool prefix correctly for ephemeral call', async () => {
    const { McpBackendAdapter } = await import('../src/backend/mcp-adapter.js');

    const pool = makePool();
    const adapter = new McpBackendAdapter('myserver', pool, stdioConfig);

    await adapter.call({
      tool: 'myserver/deep/tool_name',
      args: { x: 1 },
      agentId: 'agent1',
      meta: { sandbox: baseSandbox },
    });

    // The tool name passed to MCP client should have the prefix stripped
    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'deep/tool_name',
      arguments: { x: 1 },
    });
  });

  it('does not use ephemeral spawn for SSE servers even with sandbox', async () => {
    const { McpBackendAdapter } = await import('../src/backend/mcp-adapter.js');

    const pool = makePool({
      callTool: vi.fn().mockResolvedValue({ content: [] }),
    });
    const adapter = new McpBackendAdapter('remote', pool, sseConfig);

    const result = await adapter.call({
      tool: 'remote/action',
      args: {},
      agentId: 'agent1',
      meta: { sandbox: baseSandbox },
    });

    expect(result.success).toBe(true);
    // Should use pool, not ephemeral
    expect(pool.callTool).toHaveBeenCalled();
  });

  it('wraps command with sandbox runtime for ephemeral spawn', async () => {
    const { McpBackendAdapter } = await import('../src/backend/mcp-adapter.js');
    const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');

    const pool = makePool();
    const config: McpServerConfig = {
      type: 'stdio',
      command: 'python3',
      args: ['-m', 'myserver'],
    };
    const adapter = new McpBackendAdapter('py', pool, config);

    await adapter.call({
      tool: 'py/run',
      args: {},
      agentId: 'agent1',
      meta: { sandbox: baseSandbox },
    });

    expect(SandboxManager.wrapWithSandbox).toHaveBeenCalledWith(
      'python3 -m myserver',
      undefined,
      expect.objectContaining({
        filesystem: expect.objectContaining({
          allowWrite: ['/tmp'],
          denyRead: ['/secret'],
        }),
      })
    );
  });

  it('uses pool when serverConfig is undefined (no config)', async () => {
    const { McpBackendAdapter } = await import('../src/backend/mcp-adapter.js');

    const pool = makePool({
      callTool: vi.fn().mockResolvedValue({ content: [] }),
    });
    // No serverConfig passed
    const adapter = new McpBackendAdapter('legacy', pool);

    const result = await adapter.call({
      tool: 'legacy/action',
      args: {},
      agentId: 'agent1',
      meta: { sandbox: baseSandbox },
    });

    expect(result.success).toBe(true);
    // Should use pool since there's no server config for sandboxing
    expect(pool.callTool).toHaveBeenCalled();
  });

  it('includes env from server config in ephemeral transport', async () => {
    const { McpBackendAdapter } = await import('../src/backend/mcp-adapter.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    const configWithEnv: McpServerConfig = {
      type: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { MY_VAR: 'value' },
    };

    const pool = makePool();
    const adapter = new McpBackendAdapter('envtest', pool, configWithEnv);

    await adapter.call({
      tool: 'envtest/action',
      args: {},
      agentId: 'agent1',
      meta: { sandbox: baseSandbox },
    });

    expect(StdioClientTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        env: { MY_VAR: 'value' },
      })
    );
  });

  it('prefixes tool names with mcpId on listTools', async () => {
    const { McpBackendAdapter } = await import('../src/backend/mcp-adapter.js');

    const pool = makePool({
      listTools: vi.fn().mockResolvedValue([
        { name: 'tool_a', inputSchema: { type: 'object' } },
        { name: 'tool_b', inputSchema: { type: 'object' } },
      ]),
    });
    const adapter = new McpBackendAdapter('myns', pool, stdioConfig);

    const tools = await adapter.listTools();
    expect(tools.map((t) => t.name)).toEqual(['myns/tool_a', 'myns/tool_b']);
  });

  it('returns error for wrong prefix tool call', async () => {
    const { McpBackendAdapter } = await import('../src/backend/mcp-adapter.js');

    const pool = makePool();
    const adapter = new McpBackendAdapter('github', pool, stdioConfig);

    const result = await adapter.call({
      tool: 'other/tool',
      args: {},
      agentId: 'agent1',
      meta: { sandbox: baseSandbox },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('does not belong to adapter');
  });
});
