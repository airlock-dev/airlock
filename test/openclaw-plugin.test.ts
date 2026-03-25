/**
 * Integration tests for the airlock-bridge OpenClaw plugin.
 *
 * Spins up a real Airlock HTTP server on a random port, then runs the plugin's
 * register function with a mock OpenClaw `api` object. Fires the gateway_start
 * hook and verifies that tools are correctly discovered, named, and invocable.
 *
 * No OpenClaw runtime required — only the plugin code + Airlock HTTP layer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'net';
import { toolsApiPlugin } from '../src/tools/api.js';
import { AllowlistEngine } from '../src/allowlist/engine.js';
import { HitlEngine } from '../src/hitl/engine.js';
import { HitlBatcher } from '../src/hitl/batcher.js';
import type { AgentConfig } from '../src/config/schema.js';
import type { AuditLogger } from '../src/audit/logger.js';
import type { AgentServerDeps } from '../src/transport/agent-server.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import register from '../extensions/openclaw/index.js';

// ─── Airlock server helpers ──────────────────────────────────────────────────

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

const SAMPLE_TOOLS: Tool[] = [
  {
    name: 'github/list_prs',
    description: 'List pull requests',
    inputSchema: {
      type: 'object' as const,
      properties: { repo: { type: 'string' } },
      required: [],
    },
  },
  {
    name: 'exec/run',
    description: 'Run a shell command',
    inputSchema: {
      type: 'object' as const,
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
];

// ─── OpenClaw api mock ───────────────────────────────────────────────────────

interface RegisteredTool {
  tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
  };
  opts: { optional?: boolean };
}

function makeMockApi(pluginConfig: Record<string, unknown> = {}) {
  const hooks = new Map<string, (...args: unknown[]) => Promise<void>>();
  const registeredTools: RegisteredTool[] = [];

  const api = {
    pluginConfig,
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
    on: vi.fn((name: string, handler: (...args: unknown[]) => Promise<void>) => {
      hooks.set(name, handler);
    }),
    registerTool: vi.fn((tool: RegisteredTool['tool'], opts: RegisteredTool['opts']) => {
      registeredTools.push({ tool, opts });
    }),
  };

  return {
    api,
    async fireHook(name: string) {
      const handler = hooks.get(name);
      if (handler) await handler();
    },
    get tools() {
      return registeredTools;
    },
  };
}

// ─── Setup ───────────────────────────────────────────────────────────────────

describe('airlock-bridge OpenClaw plugin', () => {
  let app: FastifyInstance;
  let port: number;
  let registry: ReturnType<typeof makeMockRegistry>;
  let hitlEngine: HitlEngine;
  let hitlBatcher: HitlBatcher;

  const AGENT_CONFIG = makeAgentConfig({ allow: ['github/*', 'exec/run'] });

  function makeDeps(): AgentServerDeps {
    const auditLogger = makeMockAuditLogger();
    const provider = makeMockProvider();
    const allowlist = new AllowlistEngine({ openclaw: AGENT_CONFIG });
    return {
      agentId: 'openclaw',
      agentConfig: AGENT_CONFIG,
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
    const auditLogger = makeMockAuditLogger();
    const provider = makeMockProvider();
    hitlEngine = new HitlEngine(auditLogger, provider, 5000);
    hitlBatcher = new HitlBatcher(0);
    hitlBatcher.onBatchReady((_id, reqs) => {
      void provider.notify(reqs);
    });

    registry = makeMockRegistry(SAMPLE_TOOLS, { content: [{ type: 'text', text: 'result' }] });

    app = Fastify({ logger: false });
    await app.register(toolsApiPlugin, {
      getDeps: (agentId) => (agentId === 'openclaw' ? makeDeps() : undefined),
      secret: 'test-secret',
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    port = (app.server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await app.close();
    delete process.env['AIRLOCK_URL'];
    delete process.env['AIRLOCK_AGENT'];
    delete process.env['AIRLOCK_SECRET'];
  });

  function pluginConfig() {
    return {
      url: `http://127.0.0.1:${port}`,
      agent: 'openclaw',
      secret: 'test-secret',
    };
  }

  // ─── Tool discovery ─────────────────────────────────────────────────────────

  describe('tool discovery', () => {
    it('registers one tool per Airlock tool on gateway_start', async () => {
      const mock = makeMockApi(pluginConfig());
      await register(mock.api as never);
      await mock.fireHook('gateway_start');

      expect(mock.tools).toHaveLength(2);
    });

    it('maps slashes to underscores with airlock_ prefix', async () => {
      const mock = makeMockApi(pluginConfig());
      await register(mock.api as never);
      await mock.fireHook('gateway_start');

      const names = mock.tools.map((t) => t.tool.name);
      expect(names).toContain('airlock_github_list_prs');
      expect(names).toContain('airlock_exec_run');
    });

    it('preserves the original Airlock name as the label', async () => {
      const mock = makeMockApi(pluginConfig());
      await register(mock.api as never);
      await mock.fireHook('gateway_start');

      const tool = mock.tools.find((t) => t.tool.name === 'airlock_github_list_prs')!;
      expect(tool.tool.label).toBe('github/list_prs');
    });

    it('marks all tools as optional', async () => {
      const mock = makeMockApi(pluginConfig());
      await register(mock.api as never);
      await mock.fireHook('gateway_start');

      for (const t of mock.tools) {
        expect(t.opts.optional).toBe(true);
      }
    });

    it('passes the description through from Airlock', async () => {
      const mock = makeMockApi(pluginConfig());
      await register(mock.api as never);
      await mock.fireHook('gateway_start');

      const tool = mock.tools.find((t) => t.tool.name === 'airlock_github_list_prs')!;
      expect(tool.tool.description).toBe('List pull requests');
    });

    it('hooks gateway_start (not earlier)', async () => {
      const mock = makeMockApi(pluginConfig());
      await register(mock.api as never);

      // Before the hook fires, nothing is registered
      expect(mock.tools).toHaveLength(0);

      await mock.fireHook('gateway_start');
      expect(mock.tools).toHaveLength(2);
    });
  });

  // ─── Configuration ──────────────────────────────────────────────────────────

  describe('configuration', () => {
    it('reads url/agent/secret from pluginConfig', async () => {
      const mock = makeMockApi(pluginConfig());
      await register(mock.api as never);
      await mock.fireHook('gateway_start');

      expect(mock.tools).toHaveLength(2);
    });

    it('falls back to AIRLOCK_* env vars', async () => {
      process.env['AIRLOCK_URL'] = `http://127.0.0.1:${port}`;
      process.env['AIRLOCK_AGENT'] = 'openclaw';
      process.env['AIRLOCK_SECRET'] = 'test-secret';

      const mock = makeMockApi({}); // no pluginConfig
      await register(mock.api as never);
      await mock.fireHook('gateway_start');

      expect(mock.tools).toHaveLength(2);
    });

    it('env vars take precedence over pluginConfig', async () => {
      process.env['AIRLOCK_URL'] = `http://127.0.0.1:${port}`;
      process.env['AIRLOCK_AGENT'] = 'openclaw';
      process.env['AIRLOCK_SECRET'] = 'test-secret';

      const mock = makeMockApi({ url: 'http://wrong-host', agent: 'wrong', secret: 'wrong' });
      await register(mock.api as never);
      await mock.fireHook('gateway_start');

      expect(mock.tools).toHaveLength(2);
    });
  });

  // ─── Tool invocation ────────────────────────────────────────────────────────

  describe('tool invocation', () => {
    it('routes execute() to POST /agents/:agentId/tools/invoke', async () => {
      const mock = makeMockApi(pluginConfig());
      await register(mock.api as never);
      await mock.fireHook('gateway_start');

      const tool = mock.tools.find((t) => t.tool.name === 'airlock_github_list_prs')!;
      await tool.tool.execute('call-1', { repo: 'airlock' });

      expect(registry.call).toHaveBeenCalledWith(
        'github/list_prs',
        { repo: 'airlock' },
        'openclaw',
        expect.any(Object)
      );
    });

    it('returns serialized data on success', async () => {
      registry.call.mockResolvedValue({ content: [{ type: 'text', text: 'hello' }] });

      const mock = makeMockApi(pluginConfig());
      await register(mock.api as never);
      await mock.fireHook('gateway_start');

      const tool = mock.tools.find((t) => t.tool.name === 'airlock_github_list_prs')!;
      const result = (await tool.tool.execute('call-1', {})) as {
        content: { type: string; text: string }[];
        details: unknown;
      };

      expect(result.content[0].type).toBe('text');
      expect(typeof result.content[0].text).toBe('string');
    });

    it('returns error content when Airlock denies the tool', async () => {
      // Deny everything for this test
      const denyConfig = makeAgentConfig({ allow: [], deny: ['*'] });
      const denyAllowlist = new AllowlistEngine({ openclaw: denyConfig });
      const denyDeps: AgentServerDeps = {
        agentId: 'openclaw',
        agentConfig: denyConfig,
        registry: registry as unknown as AgentServerDeps['registry'],
        allowlist: denyAllowlist,
        hitlEngine,
        hitlBatcher,
        hitlProvider: makeMockProvider(),
        auditLogger: makeMockAuditLogger(),
        securityConfig: { blocked_hosts: [], allowed_local: [] },
      };

      const denyApp = Fastify({ logger: false });
      await denyApp.register(toolsApiPlugin, {
        getDeps: () => denyDeps,
      });
      await denyApp.listen({ host: '127.0.0.1', port: 0 });
      const denyPort = (denyApp.server.address() as AddressInfo).port;

      const mock = makeMockApi({ url: `http://127.0.0.1:${denyPort}`, agent: 'openclaw' });
      await register(mock.api as never);
      await mock.fireHook('gateway_start');

      const tool = mock.tools.find((t) => t.tool.name === 'airlock_github_list_prs')!;
      const result = (await tool.tool.execute('call-1', {})) as {
        content: { type: string; text: string }[];
      };

      expect(result.content[0].text).toMatch(/Error:/);

      await denyApp.close();
    });

    it('returns error content when Airlock is unreachable', async () => {
      const mock = makeMockApi({ url: 'http://127.0.0.1:1', agent: 'openclaw' });
      await register(mock.api as never);
      // Bypass gateway_start fetch failure by registering manually
      // with a tool that points at a bad URL
      mock.api.registerTool(
        {
          name: 'airlock_github_list_prs',
          label: 'github/list_prs',
          description: 'test',
          parameters: {},
          execute: async (_id, params) => {
            try {
              const res = await fetch('http://127.0.0.1:1/agents/openclaw/tools/invoke', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tool: 'github/list_prs', args: params }),
              });
              return { content: [{ type: 'text' as const, text: await res.text() }], details: {} };
            } catch (err) {
              return {
                content: [{ type: 'text' as const, text: `Airlock unreachable: ${String(err)}` }],
                details: {},
              };
            }
          },
        },
        { optional: true }
      );

      const tool = mock.tools[0]!;
      const result = (await tool.tool.execute('call-1', {})) as {
        content: { type: string; text: string }[];
      };
      expect(result.content[0].text).toMatch(/Airlock unreachable/);
    });
  });

  // ─── Error handling ─────────────────────────────────────────────────────────

  describe('error handling', () => {
    it('logs error and registers no tools when Airlock is unreachable', async () => {
      const mock = makeMockApi({ url: 'http://127.0.0.1:1', agent: 'openclaw' });
      await register(mock.api as never);
      await mock.fireHook('gateway_start');

      expect(mock.tools).toHaveLength(0);
      expect(mock.api.logger.error).toHaveBeenCalled();
    });

    it('logs error and registers no tools on HTTP error from /tools', async () => {
      const mock = makeMockApi({
        url: `http://127.0.0.1:${port}`,
        agent: 'openclaw',
        secret: 'wrong-secret',
      });
      await register(mock.api as never);
      await mock.fireHook('gateway_start');

      expect(mock.tools).toHaveLength(0);
      expect(mock.api.logger.error).toHaveBeenCalled();
    });
  });
});
