import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { toolsApiPlugin } from '../src/tools/api.js';
import { AllowlistEngine } from '../src/allowlist/engine.js';
import { HitlEngine } from '../src/hitl/engine.js';
import { HitlBatcher } from '../src/hitl/batcher.js';
import type { AgentConfig } from '../src/config/schema.js';
import type { AuditLogger } from '../src/audit/logger.js';
import type { AgentServerDeps } from '../src/transport/agent-server.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

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

function makeMockRegistry(tools: Tool[] = [], callResult: unknown = { ok: true }) {
  return {
    getFiltered: vi.fn().mockReturnValue(tools),
    call: vi.fn().mockResolvedValue(callResult),
    getAllTools: vi.fn().mockReturnValue(tools),
  };
}

function withReason(args: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...args, _airlock: { reason: 'Testing approval-gated behavior.' } };
}

const SAMPLE_TOOLS: Tool[] = [
  {
    name: 'github/list_prs',
    description: 'List pull requests',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'exec/run',
    description: 'Run a shell command',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
];

const AGENT_CONFIG = makeAgentConfig({ allow: ['github/*', 'exec/run'] });
const TOKEN_AGENT_CONFIG = makeAgentConfig({
  token: 'agent-secret',
  allow: ['github/*', 'exec/run'],
});

// ─── Setup ──────────────────────────────────────────────────────────────────

describe('toolsApiPlugin', () => {
  let app: FastifyInstance;
  let auditLogger: ReturnType<typeof makeMockAuditLogger>;
  let provider: ReturnType<typeof makeMockProvider>;
  let hitlEngine: HitlEngine;
  let hitlBatcher: HitlBatcher;
  let allowlist: AllowlistEngine;
  let registry: ReturnType<typeof makeMockRegistry>;

  function makeDeps(agentId = 'myagent', config = AGENT_CONFIG): AgentServerDeps {
    return {
      agentId,
      agentConfig: config,
      registry: registry as unknown as AgentServerDeps['registry'],
      allowlist,
      hitlEngine,
      hitlBatcher,
      hitlProvider: provider,
      auditLogger,
      securityConfig: { blocked_hosts: [], allowed_local: [] },
    };
  }

  beforeEach(async () => {
    auditLogger = makeMockAuditLogger();
    provider = makeMockProvider();
    hitlEngine = new HitlEngine(auditLogger, provider, 5000);
    hitlBatcher = new HitlBatcher(0);
    hitlBatcher.onBatchReady((_agentId, requests) => {
      void provider.notify(requests);
    });
    allowlist = new AllowlistEngine({ myagent: AGENT_CONFIG });
    registry = makeMockRegistry(SAMPLE_TOOLS, { content: [{ type: 'text', text: 'done' }] });

    app = Fastify({ logger: false });
    await app.register(toolsApiPlugin, {
      getDeps: (agentId) => (agentId === 'myagent' ? makeDeps() : undefined),
      secret: 'test-secret',
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  function getTools(agentId: string, secret = 'test-secret') {
    return app.inject({
      method: 'GET',
      url: `/agents/${agentId}/tools`,
      headers: { authorization: `Bearer ${secret}` },
    });
  }

  function invoke(agentId: string, body: Record<string, unknown>, secret = 'test-secret') {
    return app.inject({
      method: 'POST',
      url: `/agents/${agentId}/tools/invoke`,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      payload: body,
    });
  }

  async function registerTokenApp(config = TOKEN_AGENT_CONFIG): Promise<FastifyInstance> {
    const tokenApp = Fastify({ logger: false });
    const tokenAllowlist = new AllowlistEngine({ tokenagent: config });
    await tokenApp.register(toolsApiPlugin, {
      getDeps: (agentId) =>
        agentId === 'tokenagent'
          ? {
              ...makeDeps(agentId, config),
              allowlist: tokenAllowlist,
            }
          : undefined,
      secret: 'global-secret',
    });
    await tokenApp.ready();
    return tokenApp;
  }

  // ─── Auth ──────────────────────────────────────────────────────────────────

  describe('auth', () => {
    it('returns 401 with wrong secret', async () => {
      const res = await getTools('myagent', 'wrong');
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Unauthorized' });
    });

    it('returns 401 with empty auth header', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/agents/myagent/tools',
        headers: { authorization: '' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 with no auth header', async () => {
      const res = await app.inject({ method: 'GET', url: '/agents/myagent/tools' });
      expect(res.statusCode).toBe(401);
    });

    it('returns 200 with valid secret', async () => {
      const res = await getTools('myagent');
      expect(res.statusCode).toBe(200);
    });

    it('accepts the per-agent token when the agent has one', async () => {
      const tokenApp = await registerTokenApp();

      const res = await tokenApp.inject({
        method: 'GET',
        url: '/agents/tokenagent/tools',
        headers: { authorization: 'Bearer agent-secret' },
      });

      expect(res.statusCode).toBe(200);

      await tokenApp.close();
    });

    it('does not allow the global secret to access an agent with its own token', async () => {
      const tokenApp = await registerTokenApp();

      const res = await tokenApp.inject({
        method: 'GET',
        url: '/agents/tokenagent/tools',
        headers: { authorization: 'Bearer global-secret' },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Unauthorized' });

      await tokenApp.close();
    });

    it('requires the per-agent token for invoke requests too', async () => {
      const tokenApp = await registerTokenApp();

      const denied = await tokenApp.inject({
        method: 'POST',
        url: '/agents/tokenagent/tools/invoke',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer global-secret',
        },
        payload: { tool: 'github/list_prs', args: {} },
      });
      expect(denied.statusCode).toBe(401);
      expect(registry.call).not.toHaveBeenCalled();

      const allowed = await tokenApp.inject({
        method: 'POST',
        url: '/agents/tokenagent/tools/invoke',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer agent-secret',
        },
        payload: { tool: 'github/list_prs', args: {} },
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json().success).toBe(true);

      await tokenApp.close();
    });

    it('still falls back to the global secret for agents without tokens', async () => {
      const tokenApp = Fastify({ logger: false });
      await tokenApp.register(toolsApiPlugin, {
        getDeps: (agentId) => (agentId === 'myagent' ? makeDeps(agentId, AGENT_CONFIG) : undefined),
        secret: 'global-secret',
      });
      await tokenApp.ready();

      const res = await tokenApp.inject({
        method: 'GET',
        url: '/agents/myagent/tools',
        headers: { authorization: 'Bearer global-secret' },
      });

      expect(res.statusCode).toBe(200);

      await tokenApp.close();
    });

    it('allows requests when no secret is configured', async () => {
      const noAuthApp = Fastify({ logger: false });
      await noAuthApp.register(toolsApiPlugin, {
        getDeps: () => makeDeps(),
      });
      await noAuthApp.ready();

      const res = await noAuthApp.inject({ method: 'GET', url: '/agents/myagent/tools' });
      expect(res.statusCode).toBe(200);

      await noAuthApp.close();
    });
  });

  // ─── GET /agents/:agentId/tools ─────────────────────────────────────────────

  describe('GET /agents/:agentId/tools', () => {
    it('returns 404 for unknown agent', async () => {
      const res = await getTools('nobody');
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toContain('nobody');
    });

    it('returns tools filtered by registry', async () => {
      const res = await getTools('myagent');
      expect(res.statusCode).toBe(200);
      const body = res.json() as { tools: Tool[] };
      expect(body.tools).toHaveLength(2);
      expect(body.tools[0].name).toBe('github/list_prs');
      expect(registry.getFiltered).toHaveBeenCalledWith('myagent');
    });

    it('returns empty list when no tools available', async () => {
      registry.getFiltered.mockReturnValue([]);
      const res = await getTools('myagent');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ tools: [] });
    });
  });

  // ─── POST /agents/:agentId/tools/invoke — validation ────────────────────────

  describe('POST /agents/:agentId/tools/invoke — validation', () => {
    it('returns 400 when tool is missing', async () => {
      const res = await invoke('myagent', { args: {} });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('tool');
    });

    it('returns 400 for empty body', async () => {
      const res = await invoke('myagent', {});
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 for unknown agent', async () => {
      const res = await invoke('nobody', { tool: 'github/list_prs' });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toContain('nobody');
    });

    it('defaults args to empty object when not provided', async () => {
      const res = await invoke('myagent', { tool: 'github/list_prs' });
      expect(res.statusCode).toBe(200);
      expect(registry.call).toHaveBeenCalledWith(
        'github/list_prs',
        {},
        'myagent',
        expect.any(Object)
      );
    });

    it('returns 400 when args is not an object', async () => {
      const res = await invoke('myagent', { tool: 'github/list_prs', args: 'repo=airlock' });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('args');
      expect(registry.call).not.toHaveBeenCalled();
    });
  });

  // ─── POST /agents/:agentId/tools/invoke — allow ──────────────────────────────

  describe('POST /agents/:agentId/tools/invoke — allow', () => {
    it('executes tool and returns success + data', async () => {
      const res = await invoke('myagent', { tool: 'github/list_prs', args: { repo: 'airlock' } });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        success: boolean;
        data: unknown;
        metadata: { duration_ms: number; truncated: boolean };
      };
      expect(body.success).toBe(true);
      expect(body.data).toEqual({ content: [{ type: 'text', text: 'done' }] });
      expect(body.metadata.truncated).toBe(false);
      expect(typeof body.metadata.duration_ms).toBe('number');
    });

    it('calls registry with correct arguments', async () => {
      await invoke('myagent', { tool: 'github/list_prs', args: { repo: 'airlock' } });
      expect(registry.call).toHaveBeenCalledWith(
        'github/list_prs',
        { repo: 'airlock' },
        'myagent',
        expect.any(Object)
      );
    });

    it('does not invent downstream session metadata when REST session id is missing', async () => {
      await invoke('myagent', { tool: 'github/list_prs', args: { repo: 'airlock' } });

      const meta = registry.call.mock.calls.at(-1)?.[3] as Record<string, unknown>;
      expect(meta).not.toHaveProperty('downstreamSessionId');
    });

    it('rejects missing REST session id when the tool requires downstream session identity', async () => {
      const sessionApp = Fastify({ logger: false });
      await sessionApp.register(toolsApiPlugin, {
        getDeps: (agentId) => (agentId === 'myagent' ? makeDeps() : undefined),
        requiresSessionId: () => true,
      });
      await sessionApp.ready();

      const res = await sessionApp.inject({
        method: 'POST',
        url: '/agents/myagent/tools/invoke',
        headers: { 'content-type': 'application/json' },
        payload: { tool: 'github/list_prs', args: { repo: 'airlock' } },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('session_id');
      expect(registry.call).not.toHaveBeenCalled();

      await sessionApp.close();
    });

    it('uses the provided REST session id for downstream MCP session metadata', async () => {
      await invoke('myagent', {
        tool: 'github/list_prs',
        args: { repo: 'airlock' },
        session_id: 'session-a',
      });

      expect(registry.call).toHaveBeenCalledWith(
        'github/list_prs',
        { repo: 'airlock' },
        'myagent',
        expect.objectContaining({ downstreamSessionId: 'myagent:session-a' })
      );
    });

    it('accepts x-airlock-session-id when downstream session identity is required', async () => {
      const sessionApp = Fastify({ logger: false });
      await sessionApp.register(toolsApiPlugin, {
        getDeps: (agentId, sessionKey) =>
          agentId === 'myagent' ? { ...makeDeps(), downstreamSessionId: sessionKey } : undefined,
        requiresSessionId: () => true,
      });
      await sessionApp.ready();

      const res = await sessionApp.inject({
        method: 'POST',
        url: '/agents/myagent/tools/invoke',
        headers: {
          'content-type': 'application/json',
          'x-airlock-session-id': 'session-b',
        },
        payload: { tool: 'github/list_prs', args: { repo: 'airlock' } },
      });

      expect(res.statusCode).toBe(200);
      expect(registry.call).toHaveBeenCalledWith(
        'github/list_prs',
        { repo: 'airlock' },
        'myagent',
        expect.objectContaining({ downstreamSessionId: 'myagent:session-b' })
      );

      await sessionApp.close();
    });
  });

  // ─── POST /agents/:agentId/tools/invoke — deny ───────────────────────────────

  describe('POST /agents/:agentId/tools/invoke — deny', () => {
    it('returns success:false for denied tool', async () => {
      const deniedConfig = makeAgentConfig({ allow: [], deny: ['*'] });
      const deniedAllowlist = new AllowlistEngine({ strictagent: deniedConfig });
      const strictApp = Fastify({ logger: false });
      await strictApp.register(toolsApiPlugin, {
        getDeps: () => ({
          agentId: 'strictagent',
          agentConfig: deniedConfig,
          registry: registry as unknown as AgentServerDeps['registry'],
          allowlist: deniedAllowlist,
          hitlEngine,
          hitlBatcher,
          hitlProvider: provider,
          auditLogger,
          securityConfig: { blocked_hosts: [], allowed_local: [] },
        }),
      });
      await strictApp.ready();

      const res = await strictApp.inject({
        method: 'POST',
        url: '/agents/strictagent/tools/invoke',
        headers: { 'content-type': 'application/json' },
        payload: { tool: 'exec/run' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBeTruthy();

      await strictApp.close();
    });
  });

  // ─── POST /agents/:agentId/tools/invoke — HITL ───────────────────────────────

  describe('POST /agents/:agentId/tools/invoke — HITL', () => {
    let askConfig: AgentConfig;
    let askAllowlist: AllowlistEngine;
    let hitlApp: FastifyInstance;

    beforeEach(async () => {
      askConfig = makeAgentConfig({ allow: [], ask: ['github/*'] });
      askAllowlist = new AllowlistEngine({ askagent: askConfig });

      hitlApp = Fastify({ logger: false });
      await hitlApp.register(toolsApiPlugin, {
        getDeps: () => ({
          agentId: 'askagent',
          agentConfig: askConfig,
          registry: registry as unknown as AgentServerDeps['registry'],
          allowlist: askAllowlist,
          hitlEngine,
          hitlBatcher,
          hitlProvider: provider,
          auditLogger,
          securityConfig: { blocked_hosts: [], allowed_local: [] },
        }),
      });
      await hitlApp.ready();
    });

    afterEach(async () => {
      await hitlApp.close();
    });

    it('executes tool after operator approves', async () => {
      const responsePromise = hitlApp.inject({
        method: 'POST',
        url: '/agents/askagent/tools/invoke',
        headers: { 'content-type': 'application/json' },
        payload: { tool: 'github/list_prs', args: withReason() },
      });

      await vi.waitFor(() => {
        expect(hitlEngine.getPending().length).toBe(1);
      });

      const pending = hitlEngine.getPending()[0];
      expect(pending.agentId).toBe('askagent');
      hitlEngine.approveByCode(pending.code);

      const res = await responsePromise;
      expect(res.statusCode).toBe(200);
      const body = res.json() as { success: boolean };
      expect(body.success).toBe(true);
    });

    it('returns success:false after operator denies', async () => {
      const responsePromise = hitlApp.inject({
        method: 'POST',
        url: '/agents/askagent/tools/invoke',
        headers: { 'content-type': 'application/json' },
        payload: { tool: 'github/list_prs', args: withReason() },
      });

      await vi.waitFor(() => {
        expect(hitlEngine.getPending().length).toBe(1);
      });

      hitlEngine.denyByCode(hitlEngine.getPending()[0].code, 'not now');

      const res = await responsePromise;
      const body = res.json() as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBeTruthy();
    });

    it('returns success:false on HITL timeout', async () => {
      const shortEngine = new HitlEngine(auditLogger, provider, 50);
      const timeoutApp = Fastify({ logger: false });
      await timeoutApp.register(toolsApiPlugin, {
        getDeps: () => ({
          agentId: 'askagent',
          agentConfig: askConfig,
          registry: registry as unknown as AgentServerDeps['registry'],
          allowlist: askAllowlist,
          hitlEngine: shortEngine,
          hitlBatcher,
          hitlProvider: provider,
          auditLogger,
          securityConfig: { blocked_hosts: [], allowed_local: [] },
        }),
      });
      await timeoutApp.ready();

      const res = await timeoutApp.inject({
        method: 'POST',
        url: '/agents/askagent/tools/invoke',
        headers: { 'content-type': 'application/json' },
        payload: { tool: 'github/list_prs', args: withReason() },
      });
      const body = res.json() as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBeTruthy();

      await timeoutApp.close();
    });
  });

  // ─── Audit logging ──────────────────────────────────────────────────────────

  describe('audit logging', () => {
    it('logs the tool call via auditLogger', async () => {
      await invoke('myagent', { tool: 'github/list_prs' });
      expect(auditLogger.log).toHaveBeenCalled();
    });
  });
});
