import { describe, it, expect, vi } from 'vitest';
import { McpBackendAdapter } from '../src/backend/mcp-adapter.js';
import { ExecBackendAdapter } from '../src/backend/exec-adapter.js';
import { HttpBackendAdapter } from '../src/backend/http-adapter.js';
import { AirlockBackendAdapter } from '../src/backend/airlock-adapter.js';
import { ActivityStream } from '../src/activity/stream.js';
import type { ClientPool } from '../src/pool/pool.js';
import type { AgentConfig, SecurityConfig } from '../src/config/schema.js';
import { GatewayConfig } from '../src/config/schema.js';
import type { AgentVisibleTool } from '../src/registry/registry.js';

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

// --- AirlockBackendAdapter ---

describe('AirlockBackendAdapter', () => {
  it('lists ask, notify, log, status, and provider tool inspection tools', async () => {
    const adapter = new AirlockBackendAdapter();
    const tools = await adapter.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'airlock/ask_user',
      'airlock/notify_user',
      'airlock/log',
      'airlock/status',
      'airlock/list_provider_tools',
    ]);
  });

  it('emits notification activity', async () => {
    const activityStream = new ActivityStream();
    const adapter = new AirlockBackendAdapter({ activityStream });

    const result = await adapter.call({
      tool: 'airlock/notify_user',
      agentId: 'agent1',
      args: { title: 'Done', body: 'Tests passed', severity: 'success' },
    });

    expect(result.success).toBe(true);
    expect(activityStream.recent()).toMatchObject([
      { kind: 'notification', agentId: 'agent1', title: 'Done', body: 'Tests passed' },
    ]);
  });

  it('emits quiet log activity', async () => {
    const activityStream = new ActivityStream();
    const adapter = new AirlockBackendAdapter({ activityStream });

    await adapter.call({
      tool: 'airlock/log',
      agentId: 'agent1',
      args: { title: 'Checkpoint', body: 'Reached validation step' },
    });

    expect(activityStream.recent()[0]).toMatchObject({ kind: 'log', title: 'Checkpoint' });
  });

  it('reports visible provider status with allow and ask tool counts', async () => {
    const adapter = new AirlockBackendAdapter({
      getAgentConfig: () => makeAgentConfig({ allow: ['github/*', 'airlock/status'] }),
      getKnownProviderIds: () => ['airlock', 'github'],
      getProviderConnectionStatus: (providerId) =>
        providerId === 'github'
          ? { status: 'auth_required', reason: 'OAuth authorization required' }
          : undefined,
      getAgentTools: () => [
        visibleTool('github/list_prs', 'allow'),
        visibleTool('github/create_pr', 'ask'),
        visibleTool('airlock/status', 'allow'),
      ],
    });

    const result = await adapter.call({
      tool: 'airlock/status',
      agentId: 'agent1',
      args: {},
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      providers: expect.arrayContaining([
        {
          id: 'github',
          status: 'auth_required',
          reason: 'OAuth authorization required',
          toolCounts: { allow: 1, ask: 1, total: 2 },
        },
      ]),
      summary: {
        providers: { up: 1, connecting: 0, down: 0, auth_required: 1 },
        tools: { allow: 2, ask: 1, total: 3 },
      },
    });
  });

  it('includes policy-visible providers even when no tools are currently available', async () => {
    const adapter = new AirlockBackendAdapter({
      getAgentConfig: () => makeAgentConfig({ allow: ['linear/*'] }),
      getKnownProviderIds: () => ['linear'],
      getProviderConnectionStatus: () => ({ status: 'connecting', reason: 'connection refused' }),
      getAgentTools: () => [],
    });

    const result = await adapter.call({
      tool: 'airlock/status',
      agentId: 'agent1',
      args: {},
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      providers: [
        {
          id: 'linear',
          status: 'connecting',
          reason: 'connection refused',
          toolCounts: { allow: 0, ask: 0, total: 0 },
        },
      ],
    });
  });

  it('does not reveal providers hidden by an effective deny rule', async () => {
    const adapter = new AirlockBackendAdapter({
      getAgentConfig: () => makeAgentConfig({ allow: ['*'], deny: ['slack/*'] }),
      getKnownProviderIds: () => ['github', 'slack'],
      getAgentTools: () => [],
    });

    const result = await adapter.call({
      tool: 'airlock/status',
      agentId: 'agent1',
      args: {},
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      providers: [{ id: 'github', status: 'up', toolCounts: { allow: 0, ask: 0, total: 0 } }],
    });
  });

  it('lists provider tools grouped by policy decision', async () => {
    const adapter = new AirlockBackendAdapter({
      getAgentConfig: () => makeAgentConfig({ allow: ['github/*'] }),
      getKnownProviderIds: () => ['github'],
      getAgentTools: () => [
        visibleTool('github/list_prs', 'allow', 'List pull requests'),
        visibleTool('github/create_pr', 'ask', 'Create pull request'),
      ],
    });

    const result = await adapter.call({
      tool: 'airlock/list_provider_tools',
      agentId: 'agent1',
      args: { provider: 'github' },
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      providers: [
        {
          id: 'github',
          status: 'up',
          toolCounts: { allow: 1, ask: 1, total: 2 },
          tools: {
            allow: [{ name: 'github/list_prs', description: 'List pull requests' }],
            ask: [{ name: 'github/create_pr', description: 'Create pull request' }],
          },
        },
      ],
    });
  });
});

function visibleTool(
  name: string,
  decision: AgentVisibleTool['decision'],
  description = `${name} description`
): AgentVisibleTool {
  return {
    tool: { name, description, inputSchema: { type: 'object', properties: {} } },
    decision,
    providerId: name.slice(0, name.indexOf('/')),
    resolvedName: name,
  };
}
