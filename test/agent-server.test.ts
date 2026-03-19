import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createAgentServer, connectAgentServer } from '../src/transport/agent-server.js';
import { AllowlistEngine } from '../src/allowlist/engine.js';
import { HitlEngine } from '../src/hitl/engine.js';
import { HitlBatcher } from '../src/hitl/batcher.js';
import type { AgentServerDeps } from '../src/transport/agent-server.js';
import type { AgentConfig } from '../src/config/schema.js';
import type { AuditLogger } from '../src/audit/logger.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ToolRegistry } from '../src/registry/registry.js';
import { ExecBackendAdapter } from '../src/backend/exec-adapter.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    allow: [],
    ask: [],
    deny: [],
    tool_overrides: {},
    exec: { allow: [], ask: [], deny: ['*'], env: {}, default_timeout_ms: 5000 },
    http: { domain_allowlist: [], max_response_bytes: 1048576, timeout_ms: 5000 },
    middleware: [],
    ...overrides,
  };
}

function makeMockAuditLogger() {
  return {
    log: vi.fn(),
    insertHitl: vi.fn(),
    updateHitlStatus: vi.fn(),
    getPendingHitl: vi.fn().mockReturnValue([]),
  } as unknown as AuditLogger;
}

function makeMockProvider() {
  return {
    init: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockRegistry(tools: Tool[] = [], callResult: unknown = { ok: true }) {
  return {
    getFiltered: vi.fn().mockReturnValue(tools),
    call: vi.fn().mockResolvedValue(callResult),
    getAllTools: vi.fn().mockReturnValue(tools),
  };
}

async function buildConnectedClient(deps: AgentServerDeps): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createAgentServer(deps);
  await connectAgentServer(server, serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(clientTransport);
  return client;
}

function makeDeps(overrides: Partial<AgentServerDeps> = {}): AgentServerDeps {
  const auditLogger = makeMockAuditLogger();
  const provider = makeMockProvider();
  const engine = new HitlEngine(auditLogger, provider, 5000);
  const batcher = new HitlBatcher(100);
  const agentConfig = makeAgentConfig({ allow: ['github/*', 'exec/run'] });
  const allowlist = new AllowlistEngine({ agent1: agentConfig });

  return {
    agentId: 'agent1',
    agentConfig,
    registry: makeMockRegistry() as unknown as AgentServerDeps['registry'],
    allowlist,
    hitlEngine: engine,
    hitlBatcher: batcher,
    hitlProvider: provider,
    auditLogger,
    ...overrides,
  };
}

// ─── list_tools ─────────────────────────────────────────────────────────────

describe('list_tools', () => {
  it('returns filtered tools for the agent', async () => {
    const tools: Tool[] = [
      {
        name: 'github/create_pr',
        description: 'Create a PR',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'github/list_prs',
        description: 'List PRs',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
    const deps = makeDeps({
      registry: makeMockRegistry(tools) as unknown as AgentServerDeps['registry'],
    });
    const client = await buildConnectedClient(deps);
    const result = await client.listTools();
    expect(result.tools.map((t) => t.name)).toEqual(['github_create_pr', 'github_list_prs']);
  });

  it('returns empty list when agent has no allowed tools', async () => {
    const deps = makeDeps({
      registry: makeMockRegistry([]) as unknown as AgentServerDeps['registry'],
    });
    const client = await buildConnectedClient(deps);
    const result = await client.listTools();
    expect(result.tools).toHaveLength(0);
  });
});

// ─── call_tool — allowlist ───────────────────────────────────────────────────

describe('call_tool — allowlist enforcement', () => {
  it('executes allowed tool and returns result', async () => {
    const callResult = { status: 200, body: 'hello' };
    const registry = makeMockRegistry([], callResult);
    const deps = makeDeps({ registry: registry as unknown as AgentServerDeps['registry'] });
    const client = await buildConnectedClient(deps);

    const result = await client.callTool({ name: 'github/create_pr', arguments: { repo: 'test' } });
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(callResult);
  });

  it('rejects tool not in allowlist with MCP error', async () => {
    const deps = makeDeps();
    const client = await buildConnectedClient(deps);

    await expect(client.callTool({ name: 'slack/send_message', arguments: {} })).rejects.toThrow(
      'Tool not available'
    );
  });

  it('logs denied tool calls to audit', async () => {
    const auditLogger = makeMockAuditLogger();
    const deps = makeDeps({ auditLogger });
    const client = await buildConnectedClient(deps);

    await client.callTool({ name: 'slack/send_message', arguments: {} }).catch(() => {});
    expect(auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'denied', tool: 'slack/send_message' })
    );
  });

  it('logs successful tool calls with duration', async () => {
    const auditLogger = makeMockAuditLogger();
    const deps = makeDeps({ auditLogger });
    const client = await buildConnectedClient(deps);

    await client.callTool({ name: 'github/create_pr', arguments: {} });
    expect(auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        result: 'success',
        tool: 'github/create_pr',
        duration_ms: expect.any(Number),
      })
    );
  });

  it('logs errors when tool execution throws', async () => {
    const auditLogger = makeMockAuditLogger();
    const registry = makeMockRegistry();
    (registry.call as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('upstream failure'));
    const deps = makeDeps({
      auditLogger,
      registry: registry as unknown as AgentServerDeps['registry'],
    });
    const client = await buildConnectedClient(deps);

    await client.callTool({ name: 'github/create_pr', arguments: {} }).catch(() => {});
    expect(auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'error', error: 'upstream failure' })
    );
  });
});

// ─── call_tool — exec/run ────────────────────────────────────────────────────

describe('call_tool — exec/run policy', () => {
  it('rejects exec/run with no command argument', async () => {
    const deps = makeDeps();
    const client = await buildConnectedClient(deps);

    await expect(client.callTool({ name: 'exec/run', arguments: {} })).rejects.toThrow();
  });

  it('denies exec command matching deny pattern', async () => {
    const auditLogger = makeMockAuditLogger();
    const agentConfig = makeAgentConfig({
      allow: ['exec/run'],
      exec: { allow: ['git*'], ask: [], deny: ['sudo*'], env: {}, default_timeout_ms: 5000 },
    });
    const allowlist = new AllowlistEngine({ agent1: agentConfig });
    const deps = makeDeps({ agentConfig, allowlist, auditLogger });
    const client = await buildConnectedClient(deps);

    await expect(
      client.callTool({ name: 'exec/run', arguments: { command: 'sudo rm -rf /' } })
    ).rejects.toThrow('Command denied by policy');

    expect(auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'denied', tool: 'exec/run' })
    );
  });

  it('executes allowed exec command and returns output', async () => {
    const agentConfig = makeAgentConfig({
      allow: ['exec/run'],
      exec: { allow: ['echo*'], ask: [], deny: [], env: {}, default_timeout_ms: 5000 },
    });
    const agents = { agent1: agentConfig };
    const allowlist = new AllowlistEngine(agents);
    const execAdapter = new ExecBackendAdapter(agents);
    const registry = new ToolRegistry([execAdapter], allowlist, agents);
    await registry.refresh();
    const deps = makeDeps({
      agentConfig,
      allowlist,
      registry: registry as unknown as AgentServerDeps['registry'],
    });
    const client = await buildConnectedClient(deps);

    const result = await client.callTool({
      name: 'exec/run',
      arguments: { command: 'echo hello' },
    });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.stdout.trim()).toBe('hello');
    expect(parsed.exit_code).toBe(0);
  });
});

// ─── call_tool — HITL gate ───────────────────────────────────────────────────

describe('call_tool — HITL gate', () => {
  it('blocks until approved, then executes', async () => {
    const agentConfig = makeAgentConfig({ allow: ['github/*'], ask: ['github/create_pr'] });
    const allowlist = new AllowlistEngine({ agent1: agentConfig });
    const auditLogger = makeMockAuditLogger();
    const provider = makeMockProvider();
    const hitlEngine = new HitlEngine(auditLogger, provider, 10000);
    const hitlBatcher = new HitlBatcher(50);
    const registry = makeMockRegistry([], { merged: true });

    const deps = makeDeps({
      agentConfig,
      allowlist,
      auditLogger,
      hitlEngine,
      hitlBatcher,
      hitlProvider: provider,
      registry: registry as unknown as AgentServerDeps['registry'],
    });
    const client = await buildConnectedClient(deps);

    // Start the call — it will block waiting for HITL
    const callPromise = client.callTool({ name: 'github/create_pr', arguments: { repo: 'test' } });

    // Wait a tick for the engine to register the request
    await new Promise((r) => setTimeout(r, 10));

    const pending = hitlEngine.getPending();
    expect(pending).toHaveLength(1);

    // Approve it
    hitlEngine.approve(pending[0].code);

    const result = await callPromise;
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ merged: true });
    expect(auditLogger.log).toHaveBeenCalledWith(expect.objectContaining({ result: 'success' }));
  });

  it('returns error when denied', async () => {
    const agentConfig = makeAgentConfig({ allow: ['github/*'], ask: ['github/create_pr'] });
    const allowlist = new AllowlistEngine({ agent1: agentConfig });
    const auditLogger = makeMockAuditLogger();
    const provider = makeMockProvider();
    const hitlEngine = new HitlEngine(auditLogger, provider, 10000);
    const hitlBatcher = new HitlBatcher(50);
    const deps = makeDeps({
      agentConfig,
      allowlist,
      auditLogger,
      hitlEngine,
      hitlBatcher,
      hitlProvider: provider,
    });
    const client = await buildConnectedClient(deps);

    const callPromise = client.callTool({ name: 'github/create_pr', arguments: {} });
    await new Promise((r) => setTimeout(r, 10));
    hitlEngine.deny(hitlEngine.getPending()[0].code, 'not now');

    await expect(callPromise).rejects.toThrow('denied by operator');
    expect(auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'hitl_denied' })
    );
  });

  it('returns timeout error when approval times out', async () => {
    vi.useFakeTimers();
    const agentConfig = makeAgentConfig({ allow: ['github/*'], ask: ['github/create_pr'] });
    const allowlist = new AllowlistEngine({ agent1: agentConfig });
    const auditLogger = makeMockAuditLogger();
    const provider = makeMockProvider();
    const hitlEngine = new HitlEngine(auditLogger, provider, 500);
    const hitlBatcher = new HitlBatcher(50);
    const deps = makeDeps({
      agentConfig,
      allowlist,
      auditLogger,
      hitlEngine,
      hitlBatcher,
      hitlProvider: provider,
    });
    const client = await buildConnectedClient(deps);

    const callPromise = client.callTool({ name: 'github/create_pr', arguments: {} });
    vi.advanceTimersByTime(600);
    vi.useRealTimers();

    await expect(callPromise).rejects.toThrow('timed out');
    expect(auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'hitl_timeout' })
    );
  });

  it('batcher receives real id and code — not placeholder values', async () => {
    const agentConfig = makeAgentConfig({ allow: ['github/*'], ask: ['github/create_pr'] });
    const allowlist = new AllowlistEngine({ agent1: agentConfig });
    const auditLogger = makeMockAuditLogger();
    const provider = makeMockProvider();
    const hitlEngine = new HitlEngine(auditLogger, provider, 10000);
    const hitlBatcher = new HitlBatcher(50);

    const batched: import('../src/hitl/providers/types.js').HitlNotification[] = [];
    hitlBatcher.onBatchReady((_agentId, requests) => batched.push(...requests));

    const deps = makeDeps({
      agentConfig,
      allowlist,
      auditLogger,
      hitlEngine,
      hitlBatcher,
      hitlProvider: provider,
    });
    const client = await buildConnectedClient(deps);

    const callPromise = client.callTool({ name: 'github/create_pr', arguments: {} });
    await new Promise((r) => setTimeout(r, 200)); // let batcher window close

    expect(batched).toHaveLength(1);
    expect(batched[0].code).toMatch(/^[A-Z0-9]{8}$/);
    expect(batched[0].code).not.toBe('pending');
    expect(batched[0].id).not.toBe('pending');

    // Clean up — approve so the call doesn't hang
    hitlEngine.approve(batched[0].code);
    await callPromise.catch(() => {});
  });

  it('cancels pending request and errors when session signal fires during wait', async () => {
    const agentConfig = makeAgentConfig({ allow: ['github/*'], ask: ['github/create_pr'] });
    const allowlist = new AllowlistEngine({ agent1: agentConfig });
    const auditLogger = makeMockAuditLogger();
    const provider = makeMockProvider();
    const hitlEngine = new HitlEngine(auditLogger, provider, 10000);
    const hitlBatcher = new HitlBatcher(50);
    const registry = makeMockRegistry([], { merged: true });
    const ac = new AbortController();

    const deps = makeDeps({
      agentConfig,
      allowlist,
      auditLogger,
      hitlEngine,
      hitlBatcher,
      hitlProvider: provider,
      registry: registry as unknown as AgentServerDeps['registry'],
      signal: ac.signal,
    });
    const client = await buildConnectedClient(deps);

    const callPromise = client.callTool({ name: 'github/create_pr', arguments: {} });
    await new Promise((r) => setTimeout(r, 10));

    // Verify it's pending, then simulate session disconnect
    expect(hitlEngine.getPending()).toHaveLength(1);
    ac.abort();

    await expect(callPromise).rejects.toThrow('disconnected');
    // Request must be removed from pending — not dangling
    expect(hitlEngine.getPending()).toHaveLength(0);
    // Tool must NOT have executed
    expect(registry.call as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    // Audit log must reflect the disconnection
    expect(auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'hitl_disconnected' })
    );
  });

  it('errors immediately when signal is already aborted before call', async () => {
    const agentConfig = makeAgentConfig({ allow: ['github/*'], ask: ['github/create_pr'] });
    const allowlist = new AllowlistEngine({ agent1: agentConfig });
    const auditLogger = makeMockAuditLogger();
    const provider = makeMockProvider();
    const hitlEngine = new HitlEngine(auditLogger, provider, 10000);
    const hitlBatcher = new HitlBatcher(50);
    const ac = new AbortController();
    ac.abort(); // already dead before the call arrives

    const deps = makeDeps({
      agentConfig,
      allowlist,
      auditLogger,
      hitlEngine,
      hitlBatcher,
      hitlProvider: provider,
      signal: ac.signal,
    });
    const client = await buildConnectedClient(deps);

    await expect(client.callTool({ name: 'github/create_pr', arguments: {} })).rejects.toThrow(
      'disconnected'
    );

    expect(hitlEngine.getPending()).toHaveLength(0);
  });

  it('normal approval still works when signal is present but never fires', async () => {
    const agentConfig = makeAgentConfig({ allow: ['github/*'], ask: ['github/create_pr'] });
    const allowlist = new AllowlistEngine({ agent1: agentConfig });
    const auditLogger = makeMockAuditLogger();
    const provider = makeMockProvider();
    const hitlEngine = new HitlEngine(auditLogger, provider, 10000);
    const hitlBatcher = new HitlBatcher(50);
    const registry = makeMockRegistry([], { ok: true });
    const ac = new AbortController(); // never aborted

    const deps = makeDeps({
      agentConfig,
      allowlist,
      auditLogger,
      hitlEngine,
      hitlBatcher,
      hitlProvider: provider,
      registry: registry as unknown as AgentServerDeps['registry'],
      signal: ac.signal,
    });
    const client = await buildConnectedClient(deps);

    const callPromise = client.callTool({ name: 'github/create_pr', arguments: {} });
    await new Promise((r) => setTimeout(r, 10));
    hitlEngine.approve(hitlEngine.getPending()[0].code);

    const result = await callPromise;
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ ok: true });
    expect(auditLogger.log).toHaveBeenCalledWith(expect.objectContaining({ result: 'success' }));
  });

  it('exec/run command matching hitl pattern routes to HITL gate', async () => {
    const agentConfig = makeAgentConfig({
      allow: ['exec/run'],
      exec: { allow: ['git*'], ask: ['git push*'], deny: [], env: {}, default_timeout_ms: 5000 },
    });
    const agents = { agent1: agentConfig };
    const allowlist = new AllowlistEngine(agents);
    const auditLogger = makeMockAuditLogger();
    const provider = makeMockProvider();
    const hitlEngine = new HitlEngine(auditLogger, provider, 10000);
    const hitlBatcher = new HitlBatcher(50);
    const execAdapter = new ExecBackendAdapter(agents);
    const realRegistry = new ToolRegistry([execAdapter], allowlist, agents);
    await realRegistry.refresh();
    const deps = makeDeps({
      agentConfig,
      allowlist,
      auditLogger,
      hitlEngine,
      hitlBatcher,
      hitlProvider: provider,
      registry: realRegistry as unknown as AgentServerDeps['registry'],
    });
    const client = await buildConnectedClient(deps);

    const callPromise = client.callTool({
      name: 'exec/run',
      arguments: { command: 'git push origin main' },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(hitlEngine.getPending()).toHaveLength(1);
    hitlEngine.approve(hitlEngine.getPending()[0].code);
    const result = await callPromise;
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toHaveProperty('exit_code');
  });
});
