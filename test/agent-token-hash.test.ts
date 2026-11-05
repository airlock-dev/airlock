import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash } from 'crypto';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { AddressInfo } from 'net';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { agentTokenMatches, hasAgentCredential, sha256Hex } from '../src/security/request.js';
import { AgentConfig, GatewayConfig } from '../src/config/schema.js';
import { loadConfig, validateConfig } from '../src/config/loader.js';
import { toolsApiPlugin } from '../src/tools/api.js';
import { sseServerPlugin } from '../src/transport/sse-server.js';
import { AllowlistEngine } from '../src/allowlist/engine.js';
import { HitlEngine } from '../src/hitl/engine.js';
import { HitlBatcher } from '../src/hitl/batcher.js';
import type { AuditLogger } from '../src/audit/logger.js';
import type { AgentServerDeps } from '../src/transport/agent-server.js';

// The SSE success path only needs auth to pass and the transport to start; stub the MCP server.
vi.mock('../src/transport/agent-server.js', () => ({
  createAgentServer: vi.fn(() => ({})),
  connectAgentServer: vi.fn(async (_server: unknown, transport: { start: () => Promise<void> }) => {
    await transport.start();
  }),
}));

const TOKEN = 'test-agent-token-123';
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex');

function makeAgentConfig(overrides: Record<string, unknown> = {}): AgentConfig {
  return AgentConfig.parse({ allow: ['*'], ...overrides });
}

function makeDeps(agentConfig: AgentConfig): AgentServerDeps {
  const auditLogger = {
    log: vi.fn(),
    insertHitl: vi.fn(),
    updateHitlStatus: vi.fn(),
    getPendingHitl: vi.fn().mockReturnValue([]),
  } as unknown as AuditLogger;
  const provider = { init: vi.fn(), notify: vi.fn(), stop: vi.fn() };
  return {
    agentId: 'hashed',
    agentConfig,
    registry: {
      getFiltered: vi.fn().mockReturnValue([]),
    } as unknown as AgentServerDeps['registry'],
    allowlist: new AllowlistEngine({ hashed: agentConfig }),
    hitlEngine: new HitlEngine(auditLogger, provider, 5000),
    hitlBatcher: new HitlBatcher(0),
    hitlProvider: provider,
    auditLogger,
    securityConfig: { blocked_hosts: [], allowed_local: [] },
  } as unknown as AgentServerDeps;
}

describe('sha256Hex', () => {
  it('returns the lowercase hex SHA-256 digest', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
    expect(sha256Hex(TOKEN)).toBe(TOKEN_HASH);
  });
});

describe('hasAgentCredential', () => {
  it('counts token or token_sha256 as a credential', () => {
    expect(hasAgentCredential({})).toBe(false);
    expect(hasAgentCredential({ token: '' })).toBe(false);
    expect(hasAgentCredential({ token: 'x' })).toBe(true);
    expect(hasAgentCredential({ token_sha256: TOKEN_HASH })).toBe(true);
  });
});

describe('agentTokenMatches', () => {
  it('matches a plaintext token exactly as Bearer <token>', () => {
    const agent = { token: TOKEN };
    expect(agentTokenMatches(agent, `Bearer ${TOKEN}`)).toBe(true);
    expect(agentTokenMatches(agent, `Bearer ${TOKEN}x`)).toBe(false);
    expect(agentTokenMatches(agent, TOKEN)).toBe(false);
    expect(agentTokenMatches(agent, `bearer ${TOKEN}`)).toBe(false);
    expect(agentTokenMatches(agent, `Bearer  ${TOKEN}`)).toBe(false);
    expect(agentTokenMatches(agent, '')).toBe(false);
  });

  it('matches a token_sha256 agent against the presented plaintext', () => {
    const agent = { token_sha256: TOKEN_HASH };
    expect(agentTokenMatches(agent, `Bearer ${TOKEN}`)).toBe(true);
    expect(agentTokenMatches(agent, `Bearer wrong`)).toBe(false);
    expect(agentTokenMatches(agent, TOKEN)).toBe(false);
    expect(agentTokenMatches(agent, `Bearer ${TOKEN_HASH}`)).toBe(false);
    expect(agentTokenMatches(agent, 'Bearer ')).toBe(false);
    expect(agentTokenMatches(agent, '')).toBe(false);
  });

  it('never matches an agent without a credential', () => {
    expect(agentTokenMatches({}, 'Bearer ')).toBe(false);
    expect(agentTokenMatches({}, 'Bearer anything')).toBe(false);
  });
});

describe('token_sha256 config', () => {
  it('accepts a lowercase hex sha256', () => {
    expect(AgentConfig.safeParse({ token_sha256: TOKEN_HASH }).success).toBe(true);
  });

  it.each([
    ['too short', 'abc123'],
    ['uppercase', TOKEN_HASH.toUpperCase()],
    ['non-hex', 'z'.repeat(64)],
    ['too long', TOKEN_HASH + '0'],
  ])('rejects an invalid hash (%s)', (_label, value) => {
    expect(AgentConfig.safeParse({ token_sha256: value }).success).toBe(false);
  });

  it('rejects an agent that sets both token and token_sha256', () => {
    const config = GatewayConfig.parse({
      agents: { both: { token: TOKEN, token_sha256: TOKEN_HASH } },
    });
    const errors = validateConfig(config).filter((d) => d.level === 'error');
    expect(errors).toEqual([
      expect.objectContaining({
        agent: 'both',
        message: expect.stringContaining('both token and token_sha256'),
      }),
    ]);
  });

  it('fails loadConfig when an agent sets both token and token_sha256', () => {
    const dir = mkdtempSync(join(tmpdir(), 'airlock-token-hash-'));
    try {
      const path = join(dir, 'gateway.yaml');
      writeFileSync(
        path,
        `agents:\n  both:\n    token: ${TOKEN}\n    token_sha256: ${TOKEN_HASH}\n`
      );
      expect(() => loadConfig(path)).toThrow(/both token and token_sha256/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads a token_sha256-only agent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'airlock-token-hash-'));
    try {
      const path = join(dir, 'gateway.yaml');
      writeFileSync(path, `agents:\n  hashed:\n    token_sha256: ${TOKEN_HASH}\n`);
      expect(loadConfig(path).agents['hashed'].token_sha256).toBe(TOKEN_HASH);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats token_sha256 as a configured per-agent credential', () => {
    const tokenless = GatewayConfig.parse({
      server: { require_agent_tokens: true },
      agents: { hashed: { token_sha256: TOKEN_HASH }, bare: {} },
    });
    const errors = validateConfig(tokenless).filter((d) => d.level === 'error');
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors) {
      expect(e.suggestion).toContain('bare');
      expect(e.suggestion).not.toContain('hashed');
    }

    const allHashed = GatewayConfig.parse({
      server: { require_agent_tokens: true, auth_required: true },
      agents: { hashed: { token_sha256: TOKEN_HASH } },
    });
    expect(validateConfig(allHashed).filter((d) => d.level === 'error')).toEqual([]);
  });
});

describe('tools API with token_sha256', () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  async function build(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    const deps = makeDeps(makeAgentConfig({ token_sha256: TOKEN_HASH }));
    await app.register(toolsApiPlugin, {
      getDeps: (id) => (id === 'hashed' ? deps : undefined),
      secret: 'global-secret',
    });
    await app.ready();
    apps.push(app);
    return app;
  }

  it('accepts the correct token', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/agents/hashed/tools',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it.each([
    ['wrong token', { authorization: 'Bearer nope' }],
    ['global secret', { authorization: 'Bearer global-secret' }],
    ['the hash itself', { authorization: `Bearer ${TOKEN_HASH}` }],
    ['missing header', {}],
  ])('rejects %s with 401', async (_label, headers) => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/agents/hashed/tools', headers });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Unauthorized' });
  });
});

describe('SSE transport with token_sha256', () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  async function build(): Promise<number> {
    const app = Fastify({ logger: false });
    const deps = makeDeps(makeAgentConfig({ token_sha256: TOKEN_HASH }));
    await app.register(sseServerPlugin, {
      getDeps: (id) => (id === 'hashed' ? deps : undefined),
      secret: 'global-secret',
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    apps.push(app);
    return (app.server.address() as AddressInfo).port;
  }

  it('opens the stream with the correct token', async () => {
    const port = await build();
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/agents/hashed/sse`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    ac.abort();
  });

  it.each([
    ['wrong token', { authorization: 'Bearer nope' }],
    ['global secret', { authorization: 'Bearer global-secret' }],
    ['missing header', {}],
  ])('rejects %s with 401', async (_label, headers) => {
    const port = await build();
    const res = await fetch(`http://127.0.0.1:${port}/agents/hashed/sse`, { headers });
    expect(res.status).toBe(401);
  });
});
