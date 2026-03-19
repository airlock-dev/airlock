/**
 * HTTP transport (Streamable HTTP) integration tests.
 *
 * Starts a real Fastify server with the httpServerPlugin on a random port,
 * connects via the MCP SDK's StreamableHTTPClientTransport, and exercises the
 * full pipeline end-to-end.  No mocking except for AuditLogger (vi.fn stubs)
 * and the HITL provider (which has no real implementation in tests).
 *
 *   Test MCP Client
 *     ↕ StreamableHTTPClientTransport (real HTTP)
 *   httpServerPlugin (Fastify, real port)
 *     ↕ StreamableHTTPServerTransport (MCP SDK)
 *   AgentServer (real — allowlist, HITL gate, registry)
 *     ↓
 *   ToolRegistry (real)
 *     ↓
 *   FakeAdapter
 *     ↕ InMemoryTransport
 *   Downstream echo MCP server (real, in-process)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import Fastify from 'fastify';
import type { AddressInfo } from 'net';

import { createDownstreamServer } from './echo-server.js';
import { httpServerPlugin } from '../src/transport/http-server.js';
import { ToolRegistry } from '../src/registry/registry.js';
import { AllowlistEngine } from '../src/allowlist/engine.js';
import { HitlEngine } from '../src/hitl/engine.js';
import { HitlBatcher } from '../src/hitl/batcher.js';
import type { AgentConfig } from '../src/config/schema.js';
import type { AuditLogger } from '../src/audit/logger.js';
import type { BackendAdapter } from '../src/backend/types.js';
import type { ToolCall, ToolResult } from '../src/types.js';
import type { AgentServerDeps } from '../src/transport/agent-server.js';

// ─── FakeAdapter (same pattern as e2e-stack.test.ts) ─────────────────────────

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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    allow: ['tools/*'],
    ask: [],
    deny: [],
    tool_overrides: {},
    exec: { allow: [], ask: [], deny: ['*'], env: {}, default_timeout_ms: 5000 },
    http: { domain_allowlist: [], max_response_bytes: 1048576, timeout_ms: 5000 },
    sandbox: {
      enabled: false,
      presets: [],
      filesystem: { allow_write: ['.', '/tmp'], deny_read: [], deny_write: [] },
      network: { allowed_domains: [], denied_domains: [] },
      overrides: {},
    },
    middleware: [],
    extends: [],
    ...overrides,
  };
}

function makeMockAuditLogger() {
  return {
    log: vi.fn(),
    insertHitl: vi.fn(),
    updateHitlStatus: vi.fn(),
    getPendingHitl: vi.fn().mockReturnValue([]),
    query: vi.fn(),
    recent: vi.fn(),
    startDailyCleanup: vi.fn(),
    stop: vi.fn(),
  } as unknown as AuditLogger;
}

function makeMockProvider() {
  return {
    init: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

// ─── Server fixture ───────────────────────────────────────────────────────────

interface ServerFixture {
  port: number;
  hitlEngine: HitlEngine;
  auditLogger: AuditLogger;
  teardown: () => Promise<void>;
}

interface BuildServerOpts {
  /** Override fields of the default agent config */
  agentConfig?: Partial<AgentConfig>;
  /** Global API secret passed to the plugin */
  secret?: string;
  /** Additional named agents beyond 'test' */
  extraAgents?: Record<string, AgentConfig>;
}

async function buildServer(opts: BuildServerOpts = {}): Promise<ServerFixture> {
  // 1. Downstream echo server wired via in-memory transport
  const downstream = createDownstreamServer();
  const [poolClientTransport, downstreamTransport] = InMemoryTransport.createLinkedPair();
  const poolClient = new Client({ name: 'pool', version: '0.0.1' });
  await downstream.connect(downstreamTransport);
  await poolClient.connect(poolClientTransport);

  // 2. Registry and allowlist
  const agentConfig = makeAgentConfig(opts.agentConfig);
  const agents: Record<string, AgentConfig> = { test: agentConfig, ...opts.extraAgents };
  const adapter = new FakeAdapter('tools', poolClient);
  const allowlist = new AllowlistEngine(agents);
  const registry = new ToolRegistry([adapter], allowlist, agents);
  await registry.refresh();

  // 3. HITL
  const auditLogger = makeMockAuditLogger();
  const provider = makeMockProvider();
  const hitlEngine = new HitlEngine(auditLogger, provider as never, 10_000);
  const hitlBatcher = new HitlBatcher(50);

  function getDeps(agentId: string): AgentServerDeps | undefined {
    const cfg = agents[agentId];
    if (!cfg) return undefined;
    return {
      agentId,
      agentConfig: cfg,
      registry,
      allowlist,
      hitlEngine,
      hitlBatcher,
      hitlProvider: provider as never,
      auditLogger,
    };
  }

  // 4. Fastify + plugin
  // forceCloseConnections ensures app.close() doesn't hang if a test client
  // leaves an open SSE connection (e.g. after an unexpected failure).
  const app = Fastify({ logger: false, forceCloseConnections: true });
  await app.register(httpServerPlugin, { getDeps, secret: opts.secret });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;

  return {
    port,
    hitlEngine,
    auditLogger,
    teardown: async () => {
      await poolClient.close();
      await app.close();
    },
  };
}

// ─── Client helpers ───────────────────────────────────────────────────────────

// Disable reconnection so tests fail fast instead of retrying indefinitely.
const NO_RECONNECT = {
  maxRetries: 0,
  maxReconnectionDelay: 100,
  initialReconnectionDelay: 100,
  reconnectionDelayGrowFactor: 1,
};

function makeClientTransport(
  port: number,
  agentId = 'test',
  opts: { token?: string } = {}
): StreamableHTTPClientTransport {
  const url = new URL(`http://127.0.0.1:${port}/agents/${agentId}/mcp`);
  return new StreamableHTTPClientTransport(url, {
    requestInit: opts.token ? { headers: { Authorization: `Bearer ${opts.token}` } } : undefined,
    reconnectionOptions: NO_RECONNECT,
  });
}

async function connect(
  port: number,
  agentId = 'test',
  opts: { token?: string } = {}
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = makeClientTransport(port, agentId, opts);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(transport);
  return { client, transport };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('http-transport: basic MCP protocol', () => {
  let srv: ServerFixture;

  beforeEach(async () => {
    srv = await buildServer();
  });

  afterEach(async () => {
    await srv.teardown();
    vi.restoreAllMocks();
  });

  it('connects and completes MCP initialize handshake', async () => {
    const { client, transport } = await connect(srv.port);
    // If connect() resolves without throwing, the handshake succeeded.
    expect(transport.sessionId).toBeTruthy();
    await client.close();
  });

  it('each connection gets a unique session ID', async () => {
    const a = await connect(srv.port);
    const b = await connect(srv.port);
    expect(a.transport.sessionId).not.toBe(b.transport.sessionId);
    await a.client.close();
    await b.client.close();
  });

  it('lists downstream tools namespaced as tools/<name>', async () => {
    const { client } = await connect(srv.port);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('tools/echo');
    expect(names).toContain('tools/add');
    await client.close();
  });

  it('tools carry proper input schemas', async () => {
    const { client } = await connect(srv.port);
    const { tools } = await client.listTools();
    const echo = tools.find((t) => t.name === 'tools/echo')!;
    expect(echo.inputSchema).toMatchObject({
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    });
    await client.close();
  });

  it('calls tools/echo and returns the echoed message', async () => {
    const { client } = await connect(srv.port);
    const result = await client.callTool({ name: 'tools/echo', arguments: { message: 'hello' } });
    expect((result.content as { type: string; text: string }[])[0].text).toBe('hello');
    await client.close();
  });

  it('calls tools/add and returns the correct sum', async () => {
    const { client } = await connect(srv.port);
    const result = await client.callTool({ name: 'tools/add', arguments: { a: 7, b: 13 } });
    expect((result.content as { type: string; text: string }[])[0].text).toBe('20');
    await client.close();
  });

  it('proxies isError flag from downstream tool errors', async () => {
    const { client } = await connect(srv.port);
    const result = await client.callTool({ name: 'tools/error_tool', arguments: {} });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it('proxies multi-content responses', async () => {
    const { client } = await connect(srv.port);
    const result = await client.callTool({
      name: 'tools/multi_content',
      arguments: { message: 'hi' },
    });
    expect((result.content as { type: string; text: string }[]).length).toBeGreaterThanOrEqual(2);
    await client.close();
  });
});

// ─── Allowlist ────────────────────────────────────────────────────────────────

describe('http-transport: allowlist enforcement', () => {
  let srv: ServerFixture;

  beforeEach(async () => {
    srv = await buildServer({ agentConfig: { allow: ['tools/echo'], ask: [], deny: [] } });
  });

  afterEach(async () => {
    await srv.teardown();
  });

  it('allows tools that match the allowlist', async () => {
    const { client } = await connect(srv.port);
    const result = await client.callTool({ name: 'tools/echo', arguments: { message: 'ok' } });
    expect((result.content as { type: string; text: string }[])[0].text).toBe('ok');
    await client.close();
  });

  it('rejects tools not in the allowlist', async () => {
    const { client } = await connect(srv.port);
    await expect(
      client.callTool({ name: 'tools/add', arguments: { a: 1, b: 2 } })
    ).rejects.toThrow();
    await client.close();
  });

  it('filters tools from list_tools based on allowlist', async () => {
    const { client } = await connect(srv.port);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('tools/echo');
    expect(names).not.toContain('tools/add');
    await client.close();
  });

  it('rejects completely unknown tools', async () => {
    const { client } = await connect(srv.port);
    await expect(client.callTool({ name: 'nonexistent/tool', arguments: {} })).rejects.toThrow();
    await client.close();
  });
});

// ─── Auth: global secret ──────────────────────────────────────────────────────

describe('http-transport: auth — global secret', () => {
  let srv: ServerFixture;

  beforeEach(async () => {
    srv = await buildServer({ secret: 'correct-secret' });
  });

  afterEach(async () => {
    await srv.teardown();
  });

  it('allows connection with the correct secret', async () => {
    const { client, transport } = await connect(srv.port, 'test', { token: 'correct-secret' });
    expect(transport.sessionId).toBeTruthy();
    await client.close();
  });

  it('rejects connection with the wrong secret', async () => {
    const transport = makeClientTransport(srv.port, 'test', { token: 'wrong-secret' });
    const client = new Client({ name: 'test', version: '0.0.0' });
    await expect(client.connect(transport)).rejects.toThrow();
  });

  it('rejects connection with no auth header', async () => {
    const transport = makeClientTransport(srv.port, 'test');
    const client = new Client({ name: 'test', version: '0.0.0' });
    await expect(client.connect(transport)).rejects.toThrow();
  });
});

// ─── Auth: per-agent token ────────────────────────────────────────────────────

describe('http-transport: auth — per-agent token', () => {
  let srv: ServerFixture;

  beforeEach(async () => {
    srv = await buildServer({
      agentConfig: makeAgentConfig({ token: 'agent-token-abc' }),
    });
  });

  afterEach(async () => {
    await srv.teardown();
  });

  it('allows connection with the correct agent token', async () => {
    const { client, transport } = await connect(srv.port, 'test', { token: 'agent-token-abc' });
    expect(transport.sessionId).toBeTruthy();
    await client.close();
  });

  it('rejects connection with the wrong agent token', async () => {
    const transport = makeClientTransport(srv.port, 'test', { token: 'wrong-token' });
    const client = new Client({ name: 'test', version: '0.0.0' });
    await expect(client.connect(transport)).rejects.toThrow();
  });

  it('rejects connection with no token', async () => {
    const transport = makeClientTransport(srv.port, 'test');
    const client = new Client({ name: 'test', version: '0.0.0' });
    await expect(client.connect(transport)).rejects.toThrow();
  });

  it('per-agent token takes precedence over global secret (no secret set)', async () => {
    // Only agent token is checked — global secret is undefined.
    const { client } = await connect(srv.port, 'test', { token: 'agent-token-abc' });
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    await client.close();
  });
});

// ─── Auth: no secret ──────────────────────────────────────────────────────────

describe('http-transport: auth — no secret configured', () => {
  let srv: ServerFixture;

  beforeEach(async () => {
    srv = await buildServer(); // no secret
  });

  afterEach(async () => {
    await srv.teardown();
  });

  it('allows connection without any auth header', async () => {
    const { client, transport } = await connect(srv.port);
    expect(transport.sessionId).toBeTruthy();
    await client.close();
  });
});

// ─── Routing ──────────────────────────────────────────────────────────────────

describe('http-transport: routing', () => {
  let srv: ServerFixture;

  beforeEach(async () => {
    srv = await buildServer({
      extraAgents: {
        other: makeAgentConfig({ allow: ['tools/add'] }),
      },
    });
  });

  afterEach(async () => {
    await srv.teardown();
  });

  it('returns 404 for an unknown agent ID', async () => {
    const transport = makeClientTransport(srv.port, 'ghost');
    const client = new Client({ name: 'test', version: '0.0.0' });
    await expect(client.connect(transport)).rejects.toThrow();
  });

  it('routes to the correct agent — test gets tools/echo only', async () => {
    const testSrv = await buildServer({ agentConfig: { allow: ['tools/echo'] } });
    const { client } = await connect(testSrv.port, 'test');
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('tools/echo');
    expect(names).not.toContain('tools/add');
    await client.close();
    await testSrv.teardown();
  });

  it('routes to the correct agent — other agent gets tools/add only', async () => {
    const { client } = await connect(srv.port, 'other');
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('tools/add');
    expect(names).not.toContain('tools/echo');
    await client.close();
  });
});

// ─── Session management ───────────────────────────────────────────────────────

describe('http-transport: session management', () => {
  let srv: ServerFixture;

  beforeEach(async () => {
    srv = await buildServer();
  });

  afterEach(async () => {
    await srv.teardown();
  });

  it('accepts requests with a valid session ID across multiple calls', async () => {
    const { client } = await connect(srv.port);
    // Two separate tool calls on the same session
    const r1 = await client.callTool({ name: 'tools/echo', arguments: { message: 'first' } });
    const r2 = await client.callTool({ name: 'tools/echo', arguments: { message: 'second' } });
    expect((r1.content as { type: string; text: string }[])[0].text).toBe('first');
    expect((r2.content as { type: string; text: string }[])[0].text).toBe('second');
    await client.close();
  });

  it('rejects POST with an unknown session ID', async () => {
    // Send a raw POST with a bogus Mcp-Session-Id — server should 404.
    const res = await fetch(`http://127.0.0.1:${srv.port}/agents/test/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Mcp-Session-Id': 'does-not-exist',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }),
    });
    expect(res.status).toBe(404);
  });

  it('terminates session via DELETE', async () => {
    const { client, transport } = await connect(srv.port);
    const sessionId = transport.sessionId!;
    expect(sessionId).toBeTruthy();

    await transport.terminateSession();

    // After termination a new POST with the old session ID should 404.
    const res = await fetch(`http://127.0.0.1:${srv.port}/agents/test/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Mcp-Session-Id': sessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }),
    });
    expect(res.status).toBe(404);

    await client.close();
  });

  it('multiple concurrent sessions are independent', async () => {
    const a = await connect(srv.port);
    const b = await connect(srv.port);

    expect(a.transport.sessionId).not.toBe(b.transport.sessionId);

    const [r1, r2] = await Promise.all([
      a.client.callTool({ name: 'tools/echo', arguments: { message: 'from-a' } }),
      b.client.callTool({ name: 'tools/echo', arguments: { message: 'from-b' } }),
    ]);

    expect((r1.content as { type: string; text: string }[])[0].text).toBe('from-a');
    expect((r2.content as { type: string; text: string }[])[0].text).toBe('from-b');

    await a.client.close();
    await b.client.close();
  });
});

// ─── HITL ─────────────────────────────────────────────────────────────────────

describe('http-transport: HITL approval gate', () => {
  let srv: ServerFixture;

  beforeEach(async () => {
    srv = await buildServer({ agentConfig: { allow: [], ask: ['tools/*'], deny: [] } });
  });

  afterEach(async () => {
    await srv.teardown();
    vi.restoreAllMocks();
  });

  it('blocks tool call until operator approves, then returns result', async () => {
    const { client } = await connect(srv.port);

    const callPromise = client.callTool({ name: 'tools/echo', arguments: { message: 'approved' } });

    await vi.waitFor(() => expect(srv.hitlEngine.getPending().length).toBe(1), { timeout: 5000 });

    const [pending] = srv.hitlEngine.getPending();
    expect(pending.tool).toBe('tools/echo');
    srv.hitlEngine.approve(pending.code);

    const result = await callPromise;
    expect((result.content as { type: string; text: string }[])[0].text).toBe('approved');

    await client.close();
  });

  it('rejects callTool when operator denies the request', async () => {
    const { client } = await connect(srv.port);

    try {
      const callPromise = client.callTool({ name: 'tools/echo', arguments: { message: 'denied' } });

      await vi.waitFor(() => expect(srv.hitlEngine.getPending().length).toBe(1), { timeout: 5000 });

      const [pending] = srv.hitlEngine.getPending();
      srv.hitlEngine.deny(pending.code, 'not allowed right now');

      // HITL denial flows through the middleware error path → JSON-RPC error → callTool throws.
      await expect(callPromise).rejects.toThrow(/denied/i);
    } finally {
      await client.close();
    }
  });

  it('handles multiple concurrent HITL requests on the same session', async () => {
    const { client } = await connect(srv.port);

    const p1 = client.callTool({ name: 'tools/echo', arguments: { message: 'one' } });
    const p2 = client.callTool({ name: 'tools/add', arguments: { a: 3, b: 4 } });

    await vi.waitFor(() => expect(srv.hitlEngine.getPending().length).toBe(2), { timeout: 5000 });

    const pending = srv.hitlEngine.getPending();
    for (const p of pending) srv.hitlEngine.approve(p.code);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect((r1.content as { type: string; text: string }[])[0].text).toBe('one');
    expect((r2.content as { type: string; text: string }[])[0].text).toBe('7');

    await client.close();
  });

  it('handles concurrent HITL requests from different sessions independently', async () => {
    const a = await connect(srv.port);
    const b = await connect(srv.port);

    try {
      const pa = a.client.callTool({ name: 'tools/echo', arguments: { message: 'session-a' } });
      const pb = b.client.callTool({ name: 'tools/echo', arguments: { message: 'session-b' } });

      await vi.waitFor(() => expect(srv.hitlEngine.getPending().length).toBe(2), { timeout: 5000 });

      // Approve one, deny the other — denials throw from callTool.
      const pending = srv.hitlEngine.getPending();
      const byArg = (m: string) =>
        pending.find((p) => (p.args as Record<string, string>).message === m)!;
      srv.hitlEngine.approve(byArg('session-a').code);
      srv.hitlEngine.deny(byArg('session-b').code, 'no');

      // Settle both simultaneously to avoid a transient unhandled-rejection window.
      const [ra, rb] = await Promise.allSettled([pa, pb]);
      expect(ra.status).toBe('fulfilled');
      expect(
        (
          (ra as PromiseFulfilledResult<Awaited<typeof pa>>).value.content as {
            type: string;
            text: string;
          }[]
        )[0].text
      ).toBe('session-a');
      expect(rb.status).toBe('rejected');
      expect((rb as PromiseRejectedResult).reason.message).toMatch(/denied/i);
    } finally {
      await a.client.close();
      await b.client.close();
    }
  });
});

// ─── HITL timeout ────────────────────────────────────────────────────────────

describe('http-transport: HITL timeout', () => {
  it('returns an error when approval times out', async () => {
    // Build a server with a very short HITL timeout.
    const downstream = createDownstreamServer();
    const [pct, dt] = InMemoryTransport.createLinkedPair();
    const poolClient = new Client({ name: 'pool', version: '0.0.1' });
    await downstream.connect(dt);
    await poolClient.connect(pct);

    const agentConfig = makeAgentConfig({ ask: ['tools/*'], allow: [], deny: [] });
    const agents = { test: agentConfig };
    const adapter = new FakeAdapter('tools', poolClient);
    const allowlist = new AllowlistEngine(agents);
    const registry = new ToolRegistry([adapter], allowlist, agents);
    await registry.refresh();

    const auditLogger = makeMockAuditLogger();
    const provider = makeMockProvider();
    const hitlEngine = new HitlEngine(auditLogger, provider as never, 150); // 150 ms timeout
    const hitlBatcher = new HitlBatcher(0);

    const app = Fastify({ logger: false, forceCloseConnections: true });
    await app.register(httpServerPlugin, {
      getDeps: (agentId: string) =>
        agentId === 'test'
          ? {
              agentId,
              agentConfig,
              registry,
              allowlist,
              hitlEngine,
              hitlBatcher,
              hitlProvider: provider as never,
              auditLogger,
            }
          : undefined,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;

    const { client } = await connect(port);

    // Timeout flows through the middleware error path → JSON-RPC error → callTool throws.
    try {
      await expect(
        client.callTool({ name: 'tools/echo', arguments: { message: 'timeout' } })
      ).rejects.toThrow(/timed out/i);
    } finally {
      await client.close();
      await poolClient.close();
      await app.close();
    }
  }, 10_000);
});
