import { describe, it, expect, vi } from 'vitest';
import { McpBackendAdapter } from '../src/backend/mcp-adapter.js';
import { ExecBackendAdapter } from '../src/backend/exec-adapter.js';
import { HttpBackendAdapter } from '../src/backend/http-adapter.js';
import type { ClientPool } from '../src/pool/pool.js';
import type { AgentConfig, SecurityConfig } from '../src/config/schema.js';
import { GatewayConfig } from '../src/config/schema.js';

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return GatewayConfig.parse({
    agents: { test: overrides },
  }).agents['test'];
}

// --- McpBackendAdapter ---

describe('McpBackendAdapter', () => {
  function makePool(overrides: Partial<ClientPool> = {}): ClientPool {
    return {
      listTools: vi.fn().mockResolvedValue([]),
      callTool: vi.fn().mockResolvedValue({ content: [] }),
      getMcpIds: vi.fn().mockReturnValue([]),
      isReady: vi.fn().mockReturnValue(true),
      stop: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    } as unknown as ClientPool;
  }

  it('prefixes tool names with mcpId on listTools', async () => {
    const pool = makePool({
      listTools: vi.fn().mockResolvedValue([
        { name: 'create_pr', inputSchema: { type: 'object' } },
        { name: 'list_repos', inputSchema: { type: 'object' } },
      ]),
    });
    const adapter = new McpBackendAdapter('github', pool);

    const tools = await adapter.listTools();
    expect(tools.map((t) => t.name)).toEqual(['github/create_pr', 'github/list_repos']);
  });

  it('strips prefix and calls pool.callTool', async () => {
    const pool = makePool({
      callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
    });
    const adapter = new McpBackendAdapter('github', pool);

    const result = await adapter.call({
      tool: 'github/create_pr',
      args: { repo: 'test' },
      agentId: 'a1',
    });
    expect(result.success).toBe(true);
    expect(pool.callTool).toHaveBeenCalledWith('github', 'create_pr', { repo: 'test' });
  });

  it('stamps downstream MCP calls with the session id in agent metadata', async () => {
    const pool = makePool({
      callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
    });
    const adapter = new McpBackendAdapter('messages', pool);

    const result = await adapter.call({
      tool: 'messages/get_chat_messages',
      args: { chat_guid: 'chat-1' },
      agentId: 'configured-agent',
      meta: {
        downstreamSessionId: 'session-agent-1',
        mcpRequestMeta: { progressToken: 'progress-1' },
      },
    });

    expect(result.success).toBe(true);
    expect(pool.callTool).toHaveBeenCalledWith(
      'messages',
      'get_chat_messages',
      { chat_guid: 'chat-1' },
      { progressToken: 'progress-1', agentId: 'session-agent-1' }
    );
  });

  it('does not special-case send_message tool names', async () => {
    const pool = makePool({
      callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
    });
    const adapter = new McpBackendAdapter('messages', pool);

    const result = await adapter.call({
      tool: 'messages/send_message',
      args: { chat_guid: 'chat-1', message: 'hi' },
      agentId: 'configured-agent',
    });

    expect(result.success).toBe(true);
    expect(pool.callTool).toHaveBeenCalledWith('messages', 'send_message', {
      chat_guid: 'chat-1',
      message: 'hi',
    });
  });

  it('rejects tools with wrong prefix', async () => {
    const adapter = new McpBackendAdapter('github', makePool());

    const result = await adapter.call({ tool: 'filesystem/read', args: {}, agentId: 'a1' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('does not belong to adapter');
  });

  it('returns error on pool failure', async () => {
    const pool = makePool({
      callTool: vi.fn().mockRejectedValue(new Error('connection lost')),
    });
    const adapter = new McpBackendAdapter('github', pool);

    const result = await adapter.call({ tool: 'github/create_pr', args: {}, agentId: 'a1' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('connection lost');
  });

  it('has correct id format', () => {
    const adapter = new McpBackendAdapter('github', makePool());
    expect(adapter.id).toBe('mcp:github');
  });
});

// --- ExecBackendAdapter ---

describe('ExecBackendAdapter', () => {
  it('lists the exec/run tool', async () => {
    const adapter = new ExecBackendAdapter({ test: makeAgentConfig() });
    const tools = await adapter.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('exec/run');
  });

  it('rejects unknown exec tools', async () => {
    const adapter = new ExecBackendAdapter({ test: makeAgentConfig() });
    const result = await adapter.call({ tool: 'exec/nope', args: {}, agentId: 'test' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown exec tool');
  });

  it('rejects unknown agents', async () => {
    const adapter = new ExecBackendAdapter({ test: makeAgentConfig() });
    const result = await adapter.call({
      tool: 'exec/run',
      args: { command: 'echo hi' },
      agentId: 'unknown',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown agent');
  });

  it('rejects missing command argument', async () => {
    const adapter = new ExecBackendAdapter({ test: makeAgentConfig() });
    const result = await adapter.call({ tool: 'exec/run', args: {}, agentId: 'test' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing or invalid "command"');
  });

  it('rejects non-string command argument', async () => {
    const adapter = new ExecBackendAdapter({ test: makeAgentConfig() });
    const result = await adapter.call({
      tool: 'exec/run',
      args: { command: 123 },
      agentId: 'test',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing or invalid "command"');
  });

  it('has correct id', () => {
    const adapter = new ExecBackendAdapter({});
    expect(adapter.id).toBe('builtin:exec');
  });
});

// --- HttpBackendAdapter ---

describe('HttpBackendAdapter', () => {
  const security: SecurityConfig = GatewayConfig.parse({}).security;

  it('lists all HTTP method tools', async () => {
    const adapter = new HttpBackendAdapter({ test: makeAgentConfig() }, security);
    const tools = await adapter.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('http/get');
    expect(names).toContain('http/post');
    expect(names).toContain('http/delete');
    expect(names.length).toBeGreaterThanOrEqual(6);
  });

  it('rejects unknown HTTP tools', async () => {
    const adapter = new HttpBackendAdapter({ test: makeAgentConfig() }, security);
    const result = await adapter.call({ tool: 'http/ftp', args: {}, agentId: 'test' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown HTTP tool');
  });

  it('rejects tools without http/ prefix', async () => {
    const adapter = new HttpBackendAdapter({ test: makeAgentConfig() }, security);
    const result = await adapter.call({ tool: 'exec/run', args: {}, agentId: 'test' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown HTTP tool');
  });

  it('rejects unknown agents', async () => {
    const adapter = new HttpBackendAdapter({ test: makeAgentConfig() }, security);
    const result = await adapter.call({
      tool: 'http/get',
      args: { url: 'https://example.com' },
      agentId: 'unknown',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown agent');
  });

  it('has correct id', () => {
    const adapter = new HttpBackendAdapter({}, security);
    expect(adapter.id).toBe('builtin:http');
  });
});
