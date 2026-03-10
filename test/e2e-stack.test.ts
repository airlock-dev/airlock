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
import type { HealthStatus } from '../src/pool/pool.js';

// ─── FakePool ─────────────────────────────────────────────────────────────────
// Satisfies the interface ToolRegistry expects without touching production pool code.

class FakePool {
  constructor(
    private mcpId: string,
    private client: Client,
  ) {}

  getMcpIds(): string[] {
    return [this.mcpId];
  }

  async listTools(mcpId: string): Promise<Tool[]> {
    if (mcpId !== this.mcpId) throw new Error(`Unknown MCP: ${mcpId}`);
    const result = await this.client.listTools();
    return result.tools;
  }

  async callTool(mcpId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (mcpId !== this.mcpId) throw new Error(`Unknown MCP: ${mcpId}`);
    return this.client.callTool({ name: toolName, arguments: args });
  }

  healthCheck(): Record<string, HealthStatus> {
    return { [this.mcpId]: 'ok' };
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
    hitl: [],
    tool_overrides: {},
    exec: { allow: [], hitl: [], deny: ['*'], env: {}, default_timeout_ms: 5000 },
    http: { domain_allowlist: [], max_response_bytes: 1048576, timeout_ms: 5000 },
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

  // 2. Real registry wired to the fake pool
  const pool = new FakePool('tools', poolClient);
  const agents = { agent: agentConfig };
  const allowlist = new AllowlistEngine(agents);
  const registry = new ToolRegistry(pool as never, allowlist, agents, SECURITY);
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
  beforeEach(async () => { stack = await buildStack(); });
  afterEach(async () => { await stack.teardown(); vi.restoreAllMocks(); });

  it('returns downstream tools namespaced as tools/<name>', async () => {
    const { tools } = await stack.testClient.listTools();
    const names = tools.map(t => t.name);
    expect(names).toContain('tools/echo');
    expect(names).toContain('tools/add');
  });

  it('also exposes built-in http and exec tools when allowed', async () => {
    const config = makeAgentConfig({ allow: ['tools/*', 'http/*', 'exec/run'] });
    const s = await buildStack(config);
    const { tools } = await s.testClient.listTools();
    const names = tools.map(t => t.name);
    expect(names).toContain('http/get');
    expect(names).toContain('exec/run');
    await s.teardown();
  });

  it('filters out tools not in the agent allowlist', async () => {
    const restrictedConfig = makeAgentConfig({ allow: ['tools/echo'] });
    const s = await buildStack(restrictedConfig);
    const { tools } = await s.testClient.listTools();
    const names = tools.map(t => t.name);
    expect(names).toContain('tools/echo');
    expect(names).not.toContain('tools/add');
    await s.teardown();
  });
});

describe('e2e: call_tool — downstream routing', () => {
  let stack: StackFixture;
  beforeEach(async () => { stack = await buildStack(); });
  afterEach(async () => { await stack.teardown(); vi.restoreAllMocks(); });

  it('routes tools/echo through to the downstream server', async () => {
    const result = await stack.testClient.callTool({
      name: 'tools/echo',
      arguments: { message: 'hello airlock' },
    });
    // result is the raw CallToolResult from the downstream server wrapped in AgentServer
    const outer = JSON.parse((result.content[0] as { text: string }).text);
    expect(outer.content[0].text).toBe('hello airlock');
  });

  it('routes tools/add and returns the sum', async () => {
    const result = await stack.testClient.callTool({
      name: 'tools/add',
      arguments: { a: 7, b: 13 },
    });
    const outer = JSON.parse((result.content[0] as { text: string }).text);
    expect(outer.content[0].text).toBe('20');
  });

  it('rejects a tool not in the allowlist', async () => {
    // tools/add is allowed but let's call something that isn't
    await expect(
      stack.testClient.callTool({ name: 'slack/send_message', arguments: {} }),
    ).rejects.toThrow('Tool not available');
  });

  it('audit logger records successful downstream calls', async () => {
    await stack.testClient.callTool({ name: 'tools/echo', arguments: { message: 'audit me' } });
    expect(stack.auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'success', tool: 'tools/echo', agent_id: 'agent' }),
    );
  });

  it('audit logger records denied calls', async () => {
    await stack.testClient.callTool({ name: 'slack/send_message', arguments: {} }).catch(() => {});
    expect(stack.auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'denied', tool: 'slack/send_message' }),
    );
  });
});

describe('e2e: call_tool — HITL gate with real downstream', () => {
  it('blocks the downstream call until approved, then executes', async () => {
    const config = makeAgentConfig({ allow: ['tools/*'], hitl: ['tools/echo'] });
    const stack = await buildStack(config);

    const callPromise = stack.testClient.callTool({
      name: 'tools/echo',
      arguments: { message: 'needs approval' },
    });

    await new Promise(r => setTimeout(r, 20));

    const pending = stack.hitlEngine.getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].tool).toBe('tools/echo');

    stack.hitlEngine.approve(pending[0].code);

    const result = await callPromise;
    const outer = JSON.parse((result.content[0] as { text: string }).text);
    expect(outer.content[0].text).toBe('needs approval');

    expect(stack.auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'success', tool: 'tools/echo' }),
    );

    await stack.teardown();
  });

  it('returns error when HITL is denied — downstream never called', async () => {
    const config = makeAgentConfig({ allow: ['tools/*'], hitl: ['tools/add'] });
    const stack = await buildStack(config);

    const callPromise = stack.testClient.callTool({
      name: 'tools/add',
      arguments: { a: 1, b: 2 },
    });

    await new Promise(r => setTimeout(r, 20));
    stack.hitlEngine.deny(stack.hitlEngine.getPending()[0].code, 'not now');

    await expect(callPromise).rejects.toThrow('denied');
    expect(stack.auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'hitl_denied' }),
    );

    await stack.teardown();
  });
});

describe('e2e: call_tool — built-in http tool', () => {
  it('http/get to a blocked host is rejected', async () => {
    const config = makeAgentConfig({ allow: ['http/*'] });
    const stack = await buildStack(config);

    await expect(
      stack.testClient.callTool({ name: 'http/get', arguments: { url: 'http://localhost/api' } }),
    ).rejects.toThrow();

    await stack.teardown();
  });
});
