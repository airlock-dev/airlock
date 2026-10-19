/**
 * HTTP transport (Streamable HTTP) integration tests.
 *
 * Starts a real Fastify server with the httpServerPlugin on a random port,
 * connects via the MCP SDK's StreamableHTTPClientTransport, and exercises the
 * full pipeline end-to-end. The plane is stateless: 2025-era clients go through the SDK's
 * stateless legacy fallback (no Mcp-Session-Id), 2026-07-28 clients send the per-request envelope.  No mocking except for AuditLogger (vi.fn stubs)
 * and the HITL provider (which has no real implementation in tests).
 *
 *   Test MCP Client
 *     ↕ StreamableHTTPClientTransport (real HTTP)
 *   httpServerPlugin (Fastify, real port)
 *     ↕ createMcpHandler (MCP SDK, one server instance per request)
 *   AgentServer (real — allowlist, HITL gate, registry)
 *     ↓
 *   ToolRegistry (real)
 *     ↓
 *   FakeAdapter
 *     ↕ InMemoryTransport
 *   Downstream echo MCP server (real, in-process)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  Client,
  StreamableHTTPClientTransport,
  InMemoryTransport,
  SdkHttpError,
} from '@modelcontextprotocol/client';
import type { Tool } from '@modelcontextprotocol/client';
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

function withReason(args: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...args, _airlock: { reason: 'Testing approval-gated behavior.' } };
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
  /** Require auth even when no global or agent token is configured */
  authRequired?: boolean;
  /** Browser origins allowed to call the MCP endpoint */
  allowedOrigins?: string[];
  /** Additional named agents beyond 'test' */
  extraAgents?: Record<string, AgentConfig>;
  /** Captures agent-supplied session ids resolved by the plugin */
  resolveSessionId?: (agentId: string, sessionId: string) => string;
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
  await app.register(httpServerPlugin, {
    getDeps,
    secret: opts.secret,
    authRequired: opts.authRequired,
    allowedOrigins: opts.allowedOrigins,
    resolveSessionId: opts.resolveSessionId,
  });
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

interface ConnectOpts {
  token?: string;
  headers?: Record<string, string>;
  /** Speak 2026-07-28 (stateless envelope) instead of the 2025 initialize handshake. */
  modern?: boolean;
}

function makeClientTransport(
  port: number,
  agentId = 'test',
  opts: ConnectOpts = {}
): StreamableHTTPClientTransport {
  const url = new URL(`http://127.0.0.1:${port}/agents/${agentId}/mcp`);
  const headers = {
    ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    ...opts.headers,
  };
  return new StreamableHTTPClientTransport(url, {
    requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
    reconnectionOptions: NO_RECONNECT,
  });
}

async function connect(
  port: number,
  agentId = 'test',
  opts: ConnectOpts = {}
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = makeClientTransport(port, agentId, opts);
  const client = new Client(
    { name: 'test-client', version: '0.0.0' },
    opts.modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined
  );
  await client.connect(transport);
  return { client, transport };
}

async function expectUsable(client: Client): Promise<void> {
  const { tools } = await client.listTools();
  expect(tools.length).toBeGreaterThan(0);
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

  it('serves a 2025-era client statelessly: initialize succeeds, no session id is issued', async () => {
    const { client, transport } = await connect(srv.port);
    expect(transport.sessionId).toBeUndefined();
    await expectUsable(client);
    await client.close();
  });

  it('serves a 2026-07-28 client over the per-request envelope', async () => {
    const { client, transport } = await connect(srv.port, 'test', { modern: true });
    expect(transport.sessionId).toBeUndefined();
    const result = await client.callTool({ name: 'tools_echo', arguments: { message: 'modern' } });
    expect((result.content as { type: string; text: string }[])[0].text).toBe('modern');
    await client.close();
  });

  it('lists downstream tools namespaced as tools_<name>', async () => {
    const { client } = await connect(srv.port);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('tools_echo');
    expect(names).toContain('tools_add');
    await client.close();
  });

  it('tools carry proper input schemas', async () => {
    const { client } = await connect(srv.port);
    const { tools } = await client.listTools();
    const echo = tools.find((t) => t.name === 'tools_echo')!;
    expect(echo.inputSchema).toMatchObject({
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    });
    await client.close();
  });

  it('calls tools/echo and returns the echoed message', async () => {
    const { client } = await connect(srv.port);
    const result = await client.callTool({ name: 'tools_echo', arguments: { message: 'hello' } });
    expect((result.content as { type: string; text: string }[])[0].text).toBe('hello');
    await client.close();
  });

  it('calls tools/add and returns the correct sum', async () => {
    const { client } = await connect(srv.port);
    const result = await client.callTool({ name: 'tools_add', arguments: { a: 7, b: 13 } });
    expect((result.content as { type: string; text: string }[])[0].text).toBe('20');
    await client.close();
  });

  it('proxies isError flag from downstream tool errors', async () => {
    const { client } = await connect(srv.port);
    const result = await client.callTool({ name: 'tools_error_tool', arguments: {} });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it('proxies multi-content responses', async () => {
    const { client } = await connect(srv.port);
    const result = await client.callTool({
      name: 'tools_multi_content',
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
    const result = await client.callTool({ name: 'tools_echo', arguments: { message: 'ok' } });
    expect((result.content as { type: string; text: string }[])[0].text).toBe('ok');
    await client.close();
  });

  it('rejects tools not in the allowlist', async () => {
    const { client } = await connect(srv.port);
    await expect(
      client.callTool({ name: 'tools_add', arguments: { a: 1, b: 2 } })
    ).rejects.toThrow();
    await client.close();
  });

  it('filters tools from list_tools based on allowlist', async () => {
    const { client } = await connect(srv.port);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('tools_echo');
    expect(names).not.toContain('tools_add');
    await client.close();
  });

  it('rejects completely unknown tools', async () => {
    const { client } = await connect(srv.port);
    await expect(client.callTool({ name: 'nonexistent_tool', arguments: {} })).rejects.toThrow();
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
    const { client } = await connect(srv.port, 'test', { token: 'correct-secret' });
    await expectUsable(client);
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
    const { client } = await connect(srv.port, 'test', { token: 'agent-token-abc' });
    await expectUsable(client);
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

  it('does not accept the global secret for an agent with its own token', async () => {
    const mixedSrv = await buildServer({
      secret: 'global-secret',
      agentConfig: makeAgentConfig({ token: 'agent-token-abc' }),
    });
    try {
      const transport = makeClientTransport(mixedSrv.port, 'test', { token: 'global-secret' });
      const client = new Client({ name: 'test', version: '0.0.0' });
      await expect(client.connect(transport)).rejects.toThrow();
    } finally {
      await mixedSrv.teardown();
    }
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
    const { client } = await connect(srv.port);
    await expectUsable(client);
    await client.close();
  });
});

describe('http-transport: exposure hardening', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects unauthenticated connections when auth is required without a secret', async () => {
    const srv = await buildServer({ authRequired: true });
    try {
      const transport = makeClientTransport(srv.port, 'test');
      const client = new Client({ name: 'test', version: '0.0.0' });
      await expect(client.connect(transport)).rejects.toThrow();
    } finally {
      await srv.teardown();
    }
  });

  it('rejects browser-originated requests when the Origin is not allowlisted', async () => {
    const srv = await buildServer({ allowedOrigins: ['https://airlock.internal'] });
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/agents/test/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://evil.example',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Origin not allowed' });
    } finally {
      await srv.teardown();
    }
  });

  it('allows requests with no Origin header for non-browser MCP clients', async () => {
    const srv = await buildServer({ allowedOrigins: ['https://airlock.internal'] });
    try {
      const { client } = await connect(srv.port);
      await expectUsable(client);
      await client.close();
    } finally {
      await srv.teardown();
    }
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
    expect(names).toContain('tools_echo');
    expect(names).not.toContain('tools_add');
    await client.close();
    await testSrv.teardown();
  });

  it('routes to the correct agent — other agent gets tools/add only', async () => {
    const { client } = await connect(srv.port, 'other');
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('tools_add');
    expect(names).not.toContain('tools_echo');
    await client.close();
  });
});

// ─── Stateless semantics ──────────────────────────────────────────────────────

describe('http-transport: stateless serving', () => {
  let srv: ServerFixture;

  beforeEach(async () => {
    srv = await buildServer();
  });

  afterEach(async () => {
    await srv.teardown();
  });

  it('serves consecutive calls from one client without a session', async () => {
    const { client } = await connect(srv.port);
    const r1 = await client.callTool({ name: 'tools_echo', arguments: { message: 'first' } });
    const r2 = await client.callTool({ name: 'tools_echo', arguments: { message: 'second' } });
    expect((r1.content as { type: string; text: string }[])[0].text).toBe('first');
    expect((r2.content as { type: string; text: string }[])[0].text).toBe('second');
    await client.close();
  });

  it('ignores a stale Mcp-Session-Id instead of answering 404', async () => {
    // A client that cached a session id across a gateway restart must keep working — this is the
    // wedge the old session table produced.
    const res = await fetch(`http://127.0.0.1:${srv.port}/agents/test/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Session-Id': 'does-not-exist',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'raw', version: '0' },
        },
      }),
    });
    expect(res.status).toBe(200);
  });

  it.each(['GET', 'DELETE'])('answers %s with 405 (no session operations)', async (method) => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/agents/test/mcp`, {
      method,
      headers: { Accept: 'application/json, text/event-stream' },
    });
    expect(res.status).toBe(405);
  });

  it('serves many concurrent clients with no session cap', async () => {
    // The old plane capped concurrent sessions per agent (16 by default); nothing is held now.
    const clients = await Promise.all(Array.from({ length: 40 }, () => connect(srv.port)));
    const results = await Promise.all(
      clients.map(({ client }, i) =>
        client.callTool({ name: 'tools_echo', arguments: { message: `c${i}` } })
      )
    );
    results.forEach((r, i) =>
      expect((r.content as { type: string; text: string }[])[0].text).toBe(`c${i}`)
    );
    await Promise.all(clients.map(({ client }) => client.close()));
  });
});

describe('http-transport: agent-supplied session id', () => {
  it.each([
    ['X-Airlock-Session-Id header', { headers: { 'X-Airlock-Session-Id': 'codex-run-1' } }, ''],
    ['?session= query parameter', {}, '?session=codex-run-1'],
  ])('resolves the %s for the calling agent', async (_label, connectOpts, query) => {
    const resolveSessionId = vi.fn((agentId: string, id: string) => `${agentId}:${id}:opaque`);
    const srv = await buildServer({
      agentConfig: { allow: [], ask: ['tools/*'], deny: [] },
      resolveSessionId,
    });
    try {
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${srv.port}/agents/test/mcp${query}`),
        { requestInit: { headers: { ...connectOpts.headers } }, reconnectionOptions: NO_RECONNECT }
      );
      const client = new Client({ name: 'test-client', version: '0.0.0' });
      await client.connect(transport);
      const call = client.callTool({ name: 'tools_echo', arguments: withReason({ message: 'x' }) });
      await vi.waitFor(() => expect(srv.hitlEngine.getPending().length).toBe(1), { timeout: 5000 });
      expect(resolveSessionId).toHaveBeenCalledWith('test', 'codex-run-1');
      // A session-only grant binds to this agent's session, not to every agent on the profile.
      const outcome = srv.hitlEngine.approveByCode(srv.hitlEngine.getPending()[0].code, {
        grant: { scope: 'tool', sessionOnly: true },
      });
      expect(outcome?.grant?.sessionId).toBe('test:codex-run-1:opaque');
      await call;
      await client.close();
    } finally {
      await srv.teardown();
    }
  });

  it('leaves the call without a session when the agent sends none', async () => {
    const resolveSessionId = vi.fn((agentId: string, id: string) => `${agentId}:${id}`);
    const srv = await buildServer({
      agentConfig: { allow: [], ask: ['tools/*'], deny: [] },
      resolveSessionId,
    });
    try {
      const { client } = await connect(srv.port);
      const call = client.callTool({ name: 'tools_echo', arguments: withReason({ message: 'x' }) });
      await vi.waitFor(() => expect(srv.hitlEngine.getPending().length).toBe(1), { timeout: 5000 });
      expect(resolveSessionId).not.toHaveBeenCalled();
      const { code } = srv.hitlEngine.getPending()[0];
      // Never silently widened to the whole profile: a session-only grant is refused...
      expect(() =>
        srv.hitlEngine.approveByCode(code, { grant: { scope: 'tool', sessionOnly: true } })
      ).toThrow(/no session/);
      // ...while a profile-wide, time-limited grant still works.
      const outcome = srv.hitlEngine.approveByCode(code, { grant: { scope: 'tool' } });
      expect(outcome?.grant?.sessionId).toBeUndefined();
      await call;
      await client.close();
    } finally {
      await srv.teardown();
    }
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

    const callPromise = client.callTool({
      name: 'tools_echo',
      arguments: withReason({ message: 'approved' }),
    });

    await vi.waitFor(() => expect(srv.hitlEngine.getPending().length).toBe(1), { timeout: 5000 });

    const [pending] = srv.hitlEngine.getPending();
    expect(pending.tool).toBe('tools/echo');
    srv.hitlEngine.approveByCode(pending.code);

    const result = await callPromise;
    expect((result.content as { type: string; text: string }[])[0].text).toBe('approved');

    await client.close();
  });

  it('rejects callTool when operator denies the request', async () => {
    const { client } = await connect(srv.port);

    try {
      const callPromise = client.callTool({
        name: 'tools_echo',
        arguments: withReason({ message: 'denied' }),
      });

      await vi.waitFor(() => expect(srv.hitlEngine.getPending().length).toBe(1), { timeout: 5000 });

      const [pending] = srv.hitlEngine.getPending();
      srv.hitlEngine.denyByCode(pending.code, 'not allowed right now');

      // HITL denial returns isError: true so Claude sees a tool-level failure, not a protocol error.
      const result = await callPromise;
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toMatch(/denied/i);
    } finally {
      await client.close();
    }
  });

  it('handles multiple concurrent HITL requests on the same session', async () => {
    const { client } = await connect(srv.port);

    const p1 = client.callTool({ name: 'tools_echo', arguments: withReason({ message: 'one' }) });
    const p2 = client.callTool({ name: 'tools_add', arguments: withReason({ a: 3, b: 4 }) });

    await vi.waitFor(() => expect(srv.hitlEngine.getPending().length).toBe(2), { timeout: 5000 });

    const pending = srv.hitlEngine.getPending();
    for (const p of pending) srv.hitlEngine.approveByCode(p.code);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect((r1.content as { type: string; text: string }[])[0].text).toBe('one');
    expect((r2.content as { type: string; text: string }[])[0].text).toBe('7');

    await client.close();
  });

  it('handles concurrent HITL requests from different clients independently', async () => {
    const a = await connect(srv.port);
    const b = await connect(srv.port);

    try {
      const pa = a.client.callTool({
        name: 'tools_echo',
        arguments: withReason({ message: 'session-a' }),
      });
      const pb = b.client.callTool({
        name: 'tools_echo',
        arguments: withReason({ message: 'session-b' }),
      });

      await vi.waitFor(() => expect(srv.hitlEngine.getPending().length).toBe(2), { timeout: 5000 });

      // Approve one, deny the other — denials throw from callTool.
      const pending = srv.hitlEngine.getPending();
      const byArg = (m: string) =>
        pending.find((p) => (p.args as Record<string, string>).message === m)!;
      srv.hitlEngine.approveByCode(byArg('session-a').code);
      srv.hitlEngine.denyByCode(byArg('session-b').code, 'no');

      const [ra, rb] = await Promise.all([pa, pb]);
      expect((ra.content as { type: string; text: string }[])[0].text).toBe('session-a');
      expect(ra.isError).toBeFalsy();
      expect(rb.isError).toBe(true);
      expect((rb.content[0] as { text: string }).text).toMatch(/denied/i);
    } finally {
      await a.client.close();
      await b.client.close();
    }
  });
});

describe('http-transport: client disconnect', () => {
  it('cancels a call parked on approval when the client drops the request', async () => {
    // Without a session, the request's own connection is the only disconnect signal.
    const srv = await buildServer({ agentConfig: { allow: [], ask: ['tools/*'], deny: [] } });
    try {
      const ac = new AbortController();
      const req = fetch(`http://127.0.0.1:${srv.port}/agents/test/mcp`, {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2025-06-18',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'tools_echo', arguments: withReason({ message: 'abandoned' }) },
        }),
      }).catch(() => undefined);

      await vi.waitFor(() => expect(srv.hitlEngine.getPending().length).toBe(1), { timeout: 5000 });
      ac.abort();
      await req;
      await vi.waitFor(() => expect(srv.hitlEngine.getPending().length).toBe(0), { timeout: 5000 });
    } finally {
      await srv.teardown();
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

    // Timeout returns isError: true so Claude sees a tool-level failure, not a protocol error.
    try {
      const result = await client.callTool({
        name: 'tools_echo',
        arguments: withReason({ message: 'timeout' }),
      });
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toMatch(/timed out/i);
    } finally {
      await client.close();
      await poolClient.close();
      await app.close();
    }
  }, 10_000);
});

// ─── Audit request lifecycle ────────────────────────────────────────────────

describe('http-transport: audit request lifecycle', () => {
  const rowsFor = (srv: ServerFixture, needle: string) =>
    (srv.auditLogger.log as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as { tool: string; result: string; request_id?: string })
      .filter((r) => r.tool.includes(needle));

  it('emits received → dispatched → success sharing one request_id for an allowed call', async () => {
    const srv = await buildServer();
    try {
      const { client } = await connect(srv.port);
      await client.callTool({ name: 'tools_echo', arguments: { message: 'hi' } });

      const rows = rowsFor(srv, 'echo');
      const received = rows.find((r) => r.result === 'received');
      expect(received?.request_id).toBeTruthy();

      const forCall = rows
        .filter((r) => r.request_id === received!.request_id)
        .map((r) => r.result);
      expect(forCall).toContain('received');
      expect(forCall).toContain('dispatched');
      expect(forCall).toContain('success');

      await client.close();
    } finally {
      await srv.teardown();
      vi.restoreAllMocks();
    }
  });

  it('emits received then denied (never dispatched) for a blocked call, same request_id', async () => {
    const srv = await buildServer({ agentConfig: { allow: ['tools/echo'], ask: [], deny: [] } });
    try {
      const { client } = await connect(srv.port);
      await expect(
        client.callTool({ name: 'tools_add', arguments: { a: 1, b: 2 } })
      ).rejects.toThrow();

      const rows = rowsFor(srv, 'add');
      const received = rows.find((r) => r.result === 'received');
      expect(received?.request_id).toBeTruthy();

      const forCall = rows
        .filter((r) => r.request_id === received!.request_id)
        .map((r) => r.result);
      expect(forCall).toContain('received');
      expect(forCall).toContain('denied');
      expect(forCall).not.toContain('dispatched');
      expect(forCall).not.toContain('success');

      await client.close();
    } finally {
      await srv.teardown();
      vi.restoreAllMocks();
    }
  });
});
