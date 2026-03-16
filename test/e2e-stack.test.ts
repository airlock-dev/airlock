/**
 * End-to-end stack test.
 *
 * Wires the full Airlock request pipeline with a real in-process downstream
 * MCP server instead of a subprocess. Nothing is mocked except AuditLogger.
 *
 *   Test MCP Client
 *     ↕ InMemoryTransport
 *   AgentServer          (real — allowlist, HITL gate, audit, exec routing)
 *     ↓
 *   ToolRegistry         (real — namespacing, filtering, sanitization)
 *     ↓
 *   FakePool             (thin wrapper — holds a pre-connected SDK Client)
 *     ↕ InMemoryTransport
 *   Downstream MCP Server (fake — two tools: tools/echo and tools/add)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import { createDownstreamServer } from './echo-server.js';
import { createAgentServer, connectAgentServer } from '../src/transport/agent-server.js';
import { ToolRegistry } from '../src/registry/registry.js';
import { AllowlistEngine } from '../src/allowlist/engine.js';
import { HitlEngine } from '../src/hitl/engine.js';
import { HitlBatcher } from '../src/hitl/batcher.js';
import type { AgentConfig, SecurityConfig } from '../src/config/schema.js';
import type { AuditLogger } from '../src/audit/logger.js';
import type { BackendAdapter } from '../src/backend/types.js';
import type { ToolCall, ToolResult } from '../src/types.js';
import { ExecBackendAdapter } from '../src/backend/exec-adapter.js';
import { HttpBackendAdapter } from '../src/backend/http-adapter.js';

// ─── FakeAdapter ──────────────────────────────────────────────────────────────
// Wraps a connected MCP SDK Client as a BackendAdapter for testing.

class FakeAdapter implements BackendAdapter {
  readonly id: string;

  constructor(
    private mcpId: string,
    private client: Client
  ) {
    this.id = `mcp:${mcpId}`;
  }

  async listTools(): Promise<Tool[]> {
    const result = await this.client.listTools();
    return result.tools.map((t) => ({ ...t, name: `${this.mcpId}/${t.name}` }));
  }

  async call(toolCall: ToolCall): Promise<ToolResult> {
    const originalName = toolCall.tool.slice(this.mcpId.length + 1);
    try {
      const data = await this.client.callTool({ name: originalName, arguments: toolCall.args });
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async stop(): Promise<void> {}
}

// ─── Test fixtures ────────────────────────────────────────────────────────────

const SECURITY: SecurityConfig = {
  blocked_hosts: ['localhost', '127.0.0.1', '::1', '*.local', '10.*', '192.168.*', '172.16.*'],
  allowed_local: [],
};

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    allow: ['tools/*'],
    ask: [],
    notify: [],
    deny: [],
    tool_overrides: {},
    exec: { allow: [], ask: [], notify: [], deny: ['*'], env: {}, default_timeout_ms: 5000 },
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
  return { init: vi.fn(), notify: vi.fn(), stop: vi.fn() };
}

// ─── Setup: build the full stack and connect both ends ───────────────────────

interface StackFixture {
  testClient: Client;
  hitlEngine: HitlEngine;
  auditLogger: AuditLogger;
  teardown: () => Promise<void>;
}

async function buildStack(agentConfig: AgentConfig = makeAgentConfig()): Promise<StackFixture> {
  // 1. Downstream server ↔ pool client
  const downstream = createDownstreamServer();
  const [poolClientTransport, downstreamTransport] = InMemoryTransport.createLinkedPair();
  const poolClient = new Client({ name: 'airlock-pool', version: '0.1.0' });
  await downstream.connect(downstreamTransport);
  await poolClient.connect(poolClientTransport);

  // 2. Real registry wired to adapters
  const adapter = new FakeAdapter('tools', poolClient);
  const agents = { agent: agentConfig };
  const allowlist = new AllowlistEngine(agents);
  const adapters: BackendAdapter[] = [
    adapter,
    new ExecBackendAdapter(agents),
    new HttpBackendAdapter(agents, SECURITY),
  ];
  const registry = new ToolRegistry(adapters, allowlist, agents);
  await registry.refresh();

  // 3. Real HITL engine + batcher
  const auditLogger = makeMockAuditLogger();
  const provider = makeMockProvider();
  const hitlEngine = new HitlEngine(auditLogger, provider as never, 10000);
  const hitlBatcher = new HitlBatcher(50);

  // 4. AgentServer ↔ test client
  const server = createAgentServer({
    agentId: 'agent',
    agentConfig,
    registry,
    allowlist,
    hitlEngine,
    hitlBatcher,
    hitlProvider: provider as never,
    auditLogger,
  });
  const [testClientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await connectAgentServer(server, serverTransport);
  const testClient = new Client({ name: 'test', version: '0.0.1' });
  await testClient.connect(testClientTransport);

  return {
    testClient,
    hitlEngine,
    auditLogger,
    teardown: async () => {
      await testClient.close();
      await poolClient.close();
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('e2e: list_tools', () => {
  let stack: StackFixture;
  beforeEach(async () => {
    stack = await buildStack();
  });
  afterEach(async () => {
    await stack.teardown();
    vi.restoreAllMocks();
  });

  it('returns downstream tools namespaced as tools/<name>', async () => {
    const { tools } = await stack.testClient.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('tools/echo');
    expect(names).toContain('tools/add');
  });

  it('also exposes built-in http and exec tools when allowed', async () => {
    const config = makeAgentConfig({ allow: ['tools/*', 'http/*', 'exec/run'] });
    const s = await buildStack(config);
    const { tools } = await s.testClient.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('http/get');
    expect(names).toContain('exec/run');
    await s.teardown();
  });

  it('filters out tools not in the agent allowlist', async () => {
    const restrictedConfig = makeAgentConfig({ allow: ['tools/echo'] });
    const s = await buildStack(restrictedConfig);
    const { tools } = await s.testClient.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('tools/echo');
    expect(names).not.toContain('tools/add');
    await s.teardown();
  });
});

describe('e2e: call_tool — downstream routing', () => {
  let stack: StackFixture;
  beforeEach(async () => {
    stack = await buildStack();
  });
  afterEach(async () => {
    await stack.teardown();
    vi.restoreAllMocks();
  });

  it('routes tools/echo through to the downstream server', async () => {
    const result = await stack.testClient.callTool({
      name: 'tools/echo',
      arguments: { message: 'hello airlock' },
    });
    // result is the raw CallToolResult from the downstream server wrapped in AgentServer
    expect((result.content[0] as { type: string; text: string }).text).toBe('hello airlock');
  });

  it('routes tools/add and returns the sum', async () => {
    const result = await stack.testClient.callTool({
      name: 'tools/add',
      arguments: { a: 7, b: 13 },
    });
    expect((result.content[0] as { type: string; text: string }).text).toBe('20');
  });

  it('rejects a tool not in the allowlist', async () => {
    // tools/add is allowed but let's call something that isn't
    await expect(
      stack.testClient.callTool({ name: 'slack/send_message', arguments: {} })
    ).rejects.toThrow('Tool not available');
  });

  it('audit logger records successful downstream calls', async () => {
    await stack.testClient.callTool({ name: 'tools/echo', arguments: { message: 'audit me' } });
    expect(stack.auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'success', tool: 'tools/echo', agent_id: 'agent' })
    );
  });

  it('audit logger records denied calls', async () => {
    await stack.testClient.callTool({ name: 'slack/send_message', arguments: {} }).catch(() => {});
    expect(stack.auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'denied', tool: 'slack/send_message' })
    );
  });
});

describe('e2e: call_tool — HITL gate with real downstream', () => {
  it('blocks the downstream call until approved, then executes', async () => {
    const config = makeAgentConfig({ allow: ['tools/*'], ask: ['tools/echo'] });
    const stack = await buildStack(config);

    const callPromise = stack.testClient.callTool({
      name: 'tools/echo',
      arguments: { message: 'needs approval' },
    });

    await new Promise((r) => setTimeout(r, 20));

    const pending = stack.hitlEngine.getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].tool).toBe('tools/echo');

    stack.hitlEngine.approve(pending[0].code);

    const result = await callPromise;
    expect((result.content[0] as { type: string; text: string }).text).toBe('needs approval');

    expect(stack.auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'success', tool: 'tools/echo' })
    );

    await stack.teardown();
  });

  it('returns error when HITL is denied — downstream never called', async () => {
    const config = makeAgentConfig({ allow: ['tools/*'], ask: ['tools/add'] });
    const stack = await buildStack(config);

    const callPromise = stack.testClient.callTool({
      name: 'tools/add',
      arguments: { a: 1, b: 2 },
    });

    await new Promise((r) => setTimeout(r, 20));
    stack.hitlEngine.deny(stack.hitlEngine.getPending()[0].code, 'not now');

    await expect(callPromise).rejects.toThrow('denied');
    expect(stack.auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'hitl_denied' })
    );

    await stack.teardown();
  });
});

// ─── Built-in exec/run — allow / ask / deny at per-command level ─────────────

describe('e2e: exec/run — per-command policy', () => {
  it('ALLOW: runs an allowed command and returns output', async () => {
    const config = makeAgentConfig({
      allow: ['exec/run'],
      exec: { allow: ['echo*'], ask: [], notify: [], deny: [], env: {}, default_timeout_ms: 5000 },
    });
    const stack = await buildStack(config);

    const result = await stack.testClient.callTool({
      name: 'exec/run',
      arguments: { command: 'echo hello-e2e' },
    });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.stdout.trim()).toBe('hello-e2e');
    expect(parsed.exit_code).toBe(0);

    expect(stack.auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'success', tool: 'exec/run' })
    );
    await stack.teardown();
  });

  it('DENY: rejects a denied command', async () => {
    const config = makeAgentConfig({
      allow: ['exec/run'],
      exec: { allow: ['echo*'], ask: [], notify: [], deny: ['rm*'], env: {}, default_timeout_ms: 5000 },
    });
    const stack = await buildStack(config);

    await expect(
      stack.testClient.callTool({ name: 'exec/run', arguments: { command: 'rm -rf /tmp/test' } })
    ).rejects.toThrow('denied');

    expect(stack.auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'denied', tool: 'exec/run' })
    );
    await stack.teardown();
  });

  it('DENY: deny takes priority over allow', async () => {
    const config = makeAgentConfig({
      allow: ['exec/run'],
      exec: { allow: ['rm*'], ask: [], notify: [], deny: ['rm -rf*'], env: {}, default_timeout_ms: 5000 },
    });
    const stack = await buildStack(config);

    await expect(
      stack.testClient.callTool({ name: 'exec/run', arguments: { command: 'rm -rf /' } })
    ).rejects.toThrow('denied');
    await stack.teardown();
  });

  it('DENY: commands not in any list are denied (fail-closed)', async () => {
    const config = makeAgentConfig({
      allow: ['exec/run'],
      exec: { allow: ['echo*'], ask: [], notify: [], deny: [], env: {}, default_timeout_ms: 5000 },
    });
    const stack = await buildStack(config);

    await expect(
      stack.testClient.callTool({ name: 'exec/run', arguments: { command: 'cat /etc/passwd' } })
    ).rejects.toThrow('denied');
    await stack.teardown();
  });

  it('DENY: shell injection is blocked regardless of allow patterns', async () => {
    const config = makeAgentConfig({
      allow: ['exec/run'],
      exec: { allow: ['echo*'], ask: [], notify: [], deny: [], env: {}, default_timeout_ms: 5000 },
    });
    const stack = await buildStack(config);

    await expect(
      stack.testClient.callTool({
        name: 'exec/run',
        arguments: { command: 'echo hello; rm -rf /' },
      })
    ).rejects.toThrow('denied');
    await stack.teardown();
  });

  it('HITL APPROVE: command matching hitl pattern blocks, then executes on approve', async () => {
    const config = makeAgentConfig({
      allow: ['exec/run'],
      exec: {
        allow: ['echo*'],
        ask: ['echo secret*'],
        notify: [],
        deny: [],
        env: {},
        default_timeout_ms: 5000,
      },
    });
    const stack = await buildStack(config);

    const callPromise = stack.testClient.callTool({
      name: 'exec/run',
      arguments: { command: 'echo secret-data' },
    });

    await new Promise((r) => setTimeout(r, 20));
    const pending = stack.hitlEngine.getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].tool).toBe('exec/run');

    stack.hitlEngine.approve(pending[0].code);
    const result = await callPromise;
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.stdout.trim()).toBe('secret-data');

    expect(stack.auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'success', tool: 'exec/run' })
    );
    await stack.teardown();
  });

  it('HITL DENY: command matching hitl pattern blocks, then errors on deny', async () => {
    const config = makeAgentConfig({
      allow: ['exec/run'],
      exec: {
        allow: ['echo*'],
        ask: ['echo danger*'],
        notify: [],
        deny: [],
        env: {},
        default_timeout_ms: 5000,
      },
    });
    const stack = await buildStack(config);

    const callPromise = stack.testClient.callTool({
      name: 'exec/run',
      arguments: { command: 'echo danger-zone' },
    });

    await new Promise((r) => setTimeout(r, 20));
    stack.hitlEngine.deny(stack.hitlEngine.getPending()[0].code, 'nope');

    await expect(callPromise).rejects.toThrow('denied');
    expect(stack.auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'hitl_denied' })
    );
    await stack.teardown();
  });

  it('exec/run blocked at allowlist level when not in agent allow list', async () => {
    const config = makeAgentConfig({
      allow: ['tools/*'], // exec/run NOT allowed
      exec: { allow: ['echo*'], ask: [], notify: [], deny: [], env: {}, default_timeout_ms: 5000 },
    });
    const stack = await buildStack(config);

    await expect(
      stack.testClient.callTool({ name: 'exec/run', arguments: { command: 'echo hi' } })
    ).rejects.toThrow('Tool not available');
    await stack.teardown();
  });
});

// ─── Built-in http/* — allow / ask / deny ───────────────────────────────────

describe('e2e: http/* — security and policy', () => {
  it('DENY: http/get not listed returns rejected', async () => {
    // Agent only allows tools/*, not http/*
    const config = makeAgentConfig({ allow: ['tools/*'] });
    const stack = await buildStack(config);

    await expect(
      stack.testClient.callTool({ name: 'http/get', arguments: { url: 'http://example.com' } })
    ).rejects.toThrow('Tool not available');
    await stack.teardown();
  });

  it('DENY: blocked host (localhost) is rejected', async () => {
    const config = makeAgentConfig({ allow: ['http/*'] });
    const stack = await buildStack(config);

    await expect(
      stack.testClient.callTool({ name: 'http/get', arguments: { url: 'http://localhost/api' } })
    ).rejects.toThrow();

    expect(stack.auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'error', tool: 'http/get' })
    );
    await stack.teardown();
  });

  it('DENY: blocked host (127.0.0.1) is rejected', async () => {
    const config = makeAgentConfig({ allow: ['http/*'] });
    const stack = await buildStack(config);

    await expect(
      stack.testClient.callTool({ name: 'http/get', arguments: { url: 'http://127.0.0.1:8080/x' } })
    ).rejects.toThrow();
    await stack.teardown();
  });

  it('DENY: blocked host (10.* RFC-1918) is rejected', async () => {
    const config = makeAgentConfig({ allow: ['http/*'] });
    const stack = await buildStack(config);

    await expect(
      stack.testClient.callTool({
        name: 'http/get',
        arguments: { url: 'http://10.0.0.1/internal' },
      })
    ).rejects.toThrow();
    await stack.teardown();
  });

  it('DENY: domain not in agent allowlist is rejected', async () => {
    const config = makeAgentConfig({
      allow: ['http/*'],
      http: { domain_allowlist: ['api.github.com'], max_response_bytes: 1048576, timeout_ms: 5000 },
    });
    const stack = await buildStack(config);

    await expect(
      stack.testClient.callTool({ name: 'http/get', arguments: { url: 'http://evil.com/steal' } })
    ).rejects.toThrow();

    expect(stack.auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'error', tool: 'http/get' })
    );
    await stack.teardown();
  });

  it('DENY: invalid URL is rejected', async () => {
    const config = makeAgentConfig({ allow: ['http/*'] });
    const stack = await buildStack(config);

    await expect(
      stack.testClient.callTool({ name: 'http/get', arguments: { url: 'not-a-url' } })
    ).rejects.toThrow();
    await stack.teardown();
  });

  it('HITL APPROVE: http tool gated by HITL, approved executes', async () => {
    const config = makeAgentConfig({
      allow: ['http/*'],
      ask: ['http/post'],
      http: { domain_allowlist: ['httpbin.org'], max_response_bytes: 1048576, timeout_ms: 5000 },
    });
    const stack = await buildStack(config);

    const callPromise = stack.testClient.callTool({
      name: 'http/post',
      arguments: { url: 'http://httpbin.org/post', body: '{"test":1}' },
    });

    await new Promise((r) => setTimeout(r, 20));
    const pending = stack.hitlEngine.getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].tool).toBe('http/post');

    stack.hitlEngine.approve(pending[0].code);
    // The call will go through to httpbin — we just verify it doesn't throw
    const result = await callPromise;
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.status).toBe(200);
    await stack.teardown();
  });

  it('HITL DENY: http tool gated by HITL, denied returns error', async () => {
    const config = makeAgentConfig({
      allow: ['http/*'],
      ask: ['http/get'],
      http: { domain_allowlist: ['example.com'], max_response_bytes: 1048576, timeout_ms: 5000 },
    });
    const stack = await buildStack(config);

    const callPromise = stack.testClient.callTool({
      name: 'http/get',
      arguments: { url: 'http://example.com' },
    });

    await new Promise((r) => setTimeout(r, 20));
    stack.hitlEngine.deny(stack.hitlEngine.getPending()[0].code, 'not allowed');

    await expect(callPromise).rejects.toThrow('denied');
    expect(stack.auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'hitl_denied', tool: 'http/get' })
    );
    await stack.teardown();
  });

  it('http/* tools hidden from list_tools when not in allowlist', async () => {
    const config = makeAgentConfig({ allow: ['tools/*'] }); // no http/*
    const stack = await buildStack(config);

    const { tools } = await stack.testClient.listTools();
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('http/get');
    expect(names).not.toContain('http/post');
    await stack.teardown();
  });

  it('only allowed http methods appear in list_tools', async () => {
    const config = makeAgentConfig({ allow: ['http/get', 'http/head'] });
    const stack = await buildStack(config);

    const { tools } = await stack.testClient.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('http/get');
    expect(names).toContain('http/head');
    expect(names).not.toContain('http/post');
    expect(names).not.toContain('http/delete');
    await stack.teardown();
  });
});

// ─── External MCP — HITL with wildcard patterns ─────────────────────────────

describe('e2e: external MCP — HITL wildcard patterns', () => {
  it('HITL on wildcard pattern: tools/* all require HITL', async () => {
    const config = makeAgentConfig({ allow: ['tools/*'], ask: ['tools/*'] });
    const stack = await buildStack(config);

    const callPromise = stack.testClient.callTool({
      name: 'tools/add',
      arguments: { a: 1, b: 2 },
    });

    await new Promise((r) => setTimeout(r, 20));
    const pending = stack.hitlEngine.getPending();
    expect(pending).toHaveLength(1);

    stack.hitlEngine.approve(pending[0].code);
    const result = await callPromise;
    expect((result.content[0] as { type: string; text: string }).text).toBe('3');
    await stack.teardown();
  });

  it('HITL on specific tool only — other tools pass through', async () => {
    const config = makeAgentConfig({ allow: ['tools/*'], ask: ['tools/add'] });
    const stack = await buildStack(config);

    // tools/echo should pass without HITL
    const echoResult = await stack.testClient.callTool({
      name: 'tools/echo',
      arguments: { message: 'no hitl needed' },
    });
    expect((echoResult.content[0] as { type: string; text: string }).text).toBe('no hitl needed');
    expect(stack.hitlEngine.getPending()).toHaveLength(0);

    // tools/add should require HITL
    const addPromise = stack.testClient.callTool({
      name: 'tools/add',
      arguments: { a: 10, b: 20 },
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(stack.hitlEngine.getPending()).toHaveLength(1);

    stack.hitlEngine.approve(stack.hitlEngine.getPending()[0].code);
    const addResult = await addPromise;
    expect((addResult.content[0] as { type: string; text: string }).text).toBe('30');
    await stack.teardown();
  });

  it('HITL timeout on external MCP tool', async () => {
    vi.useFakeTimers();
    const auditLogger = makeMockAuditLogger();
    const provider = makeMockProvider();
    const hitlEngine = new HitlEngine(auditLogger, provider as never, 500);

    const config = makeAgentConfig({ allow: ['tools/*'], ask: ['tools/echo'] });

    // Build stack manually to inject the short-timeout engine
    const downstream = createDownstreamServer();
    const [poolClientTransport, downstreamTransport] = InMemoryTransport.createLinkedPair();
    const poolClient = new Client({ name: 'airlock-pool', version: '0.1.0' });
    await downstream.connect(downstreamTransport);
    await poolClient.connect(poolClientTransport);

    const fakeAdapter = new FakeAdapter('tools', poolClient);
    const agents = { agent: config };
    const allowlist = new AllowlistEngine(agents);
    const adapters2: BackendAdapter[] = [
      fakeAdapter,
      new ExecBackendAdapter(agents),
      new HttpBackendAdapter(agents, SECURITY),
    ];
    const registry = new ToolRegistry(adapters2, allowlist, agents);
    await registry.refresh();

    const hitlBatcher = new HitlBatcher(50);
    const server = createAgentServer({
      agentId: 'agent',
      agentConfig: config,
      registry,
      allowlist,
      hitlEngine,
      hitlBatcher,
      hitlProvider: provider as never,
      auditLogger,
    });
    const [testClientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await connectAgentServer(server, serverTransport);
    const testClient = new Client({ name: 'test', version: '0.0.1' });
    await testClient.connect(testClientTransport);

    const callPromise = testClient.callTool({
      name: 'tools/echo',
      arguments: { message: 'will timeout' },
    });

    vi.advanceTimersByTime(600);
    vi.useRealTimers();

    await expect(callPromise).rejects.toThrow('timed out');
    expect(auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'hitl_timeout', tool: 'tools/echo' })
    );

    await testClient.close();
    await poolClient.close();
  });
});

// ─── Mixed: allow some, ask some, deny some ─────────────────────────────────

describe('e2e: mixed policy — allow + ask + deny across tool types', () => {
  it('agent with mixed policy: MCP allowed, exec approval-gated, http blocked', async () => {
    const config = makeAgentConfig({
      allow: ['tools/echo', 'exec/run'], // no http/*
      ask: [],
      exec: {
        allow: ['echo*'],
        ask: ['echo deploy*'],
        notify: [],
        deny: ['rm*'],
        env: {},
        default_timeout_ms: 5000,
      },
    });
    const stack = await buildStack(config);

    // MCP tool — allowed, passes through
    const echoResult = await stack.testClient.callTool({
      name: 'tools/echo',
      arguments: { message: 'allowed' },
    });
    expect((echoResult.content[0] as { type: string; text: string }).text).toBe('allowed');

    // exec — allowed command passes through
    const execResult = await stack.testClient.callTool({
      name: 'exec/run',
      arguments: { command: 'echo simple' },
    });
    const execParsed = JSON.parse((execResult.content[0] as { text: string }).text);
    expect(execParsed.stdout.trim()).toBe('simple');

    // exec — hitl-gated command blocks
    const deployPromise = stack.testClient.callTool({
      name: 'exec/run',
      arguments: { command: 'echo deploy-prod' },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(stack.hitlEngine.getPending()).toHaveLength(1);
    stack.hitlEngine.approve(stack.hitlEngine.getPending()[0].code);
    const deployResult = await deployPromise;
    const deployParsed = JSON.parse((deployResult.content[0] as { text: string }).text);
    expect(deployParsed.stdout.trim()).toBe('deploy-prod');

    // exec — denied command blocked
    await expect(
      stack.testClient.callTool({ name: 'exec/run', arguments: { command: 'rm -rf /tmp' } })
    ).rejects.toThrow('denied');

    // http — not in allowlist, rejected at tool level
    await expect(
      stack.testClient.callTool({ name: 'http/get', arguments: { url: 'http://example.com' } })
    ).rejects.toThrow('Tool not available');

    // MCP tool not in allowlist — blocked
    await expect(
      stack.testClient.callTool({ name: 'tools/add', arguments: { a: 1, b: 2 } })
    ).rejects.toThrow('Tool not available');

    await stack.teardown();
  });
});
