import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { hookApiPlugin } from '../src/hook/api.js';
import { AllowlistEngine } from '../src/allowlist/engine.js';
import { HitlEngine } from '../src/hitl/engine.js';
import { HitlBatcher } from '../src/hitl/batcher.js';
import type { AgentConfig } from '../src/config/schema.js';

function makeMockAuditLogger() {
  return {
    insertHitl: vi.fn(),
    updateHitlStatus: vi.fn(),
    getPendingHitl: vi.fn().mockReturnValue([]),
    log: vi.fn(),
    query: vi.fn(),
    recent: vi.fn(),
    startDailyCleanup: vi.fn(),
    stop: vi.fn(),
  } as unknown as import('../src/audit/logger.js').AuditLogger;
}

function makeMockProvider() {
  return {
    init: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

// Realistic claude-code agent config using specificity-aware patterns.
// More specific allow patterns like 'bash/git*' beat the broad ask catch-all 'bash/*'.
const DEFAULT_AGENT: AgentConfig = {
  extends: [],
  allow: ['bash/git*', 'bash/npm*', 'bash/npx*', 'file/read', 'file/glob', 'file/grep'],
  ask: ['bash/*', 'file/edit', 'file/write'],
  deny: ['bash/rm*', 'bash/sudo*', 'bash/_complex'],
  exec: { allow: [], ask: [], deny: [], default_timeout_ms: 30000 },
  http: { allow: [], ask: [], deny: [] },
  middleware: [],
};

// Restrictive agent — asks for everything, allows nothing directly
const RESTRICTED_AGENT: AgentConfig = {
  extends: [],
  allow: ['file/read', 'file/glob', 'file/grep'],
  ask: ['bash/*', 'file/*'],
  deny: ['bash/rm*', 'bash/sudo*', 'bash/_complex'],
  exec: { allow: [], ask: [], deny: [], default_timeout_ms: 30000 },
  http: { allow: [], ask: [], deny: [] },
  middleware: [],
};

describe('hookApiPlugin', () => {
  let app: FastifyInstance;
  let auditLogger: ReturnType<typeof makeMockAuditLogger>;
  let provider: ReturnType<typeof makeMockProvider>;
  let hitlEngine: HitlEngine;
  let hitlBatcher: HitlBatcher;
  let allowlist: AllowlistEngine;

  beforeEach(async () => {
    auditLogger = makeMockAuditLogger();
    provider = makeMockProvider();
    hitlEngine = new HitlEngine(auditLogger, provider, 5000);
    hitlBatcher = new HitlBatcher(0); // no batching delay for tests
    hitlBatcher.onBatchReady((_agentId, requests) => {
      void provider.notify(requests);
    });
    allowlist = new AllowlistEngine({
      'claude-code': DEFAULT_AGENT,
      restricted: RESTRICTED_AGENT,
    });

    app = Fastify({ logger: false });
    await app.register(hookApiPlugin, {
      allowlist,
      hitlEngine,
      hitlBatcher,
      auditLogger,
      secret: 'test-secret',
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  function post(body: Record<string, unknown>, secret = 'test-secret') {
    return app.inject({
      method: 'POST',
      url: '/hook',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
      },
      payload: body,
    });
  }

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------
  describe('auth', () => {
    it('returns 401 with wrong secret', async () => {
      const res = await post({ client: 'claude-code', tool: 'Read' }, 'wrong');
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Unauthorized' });
    });

    it('returns 401 with empty auth header', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/hook',
        headers: { 'content-type': 'application/json', authorization: '' },
        payload: { client: 'claude-code', tool: 'Read', input: {} },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 with no auth header', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/hook',
        headers: { 'content-type': 'application/json' },
        payload: { client: 'claude-code', tool: 'Read', input: {} },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 200 with valid secret', async () => {
      const res = await post({ client: 'claude-code', tool: 'Read', input: {} });
      expect(res.statusCode).toBe(200);
    });

    it('allows requests when no secret is configured', async () => {
      const noAuthApp = Fastify({ logger: false });
      await noAuthApp.register(hookApiPlugin, {
        allowlist,
        hitlEngine,
        hitlBatcher,
        auditLogger,
        // no secret
      });
      await noAuthApp.ready();

      const res = await noAuthApp.inject({
        method: 'POST',
        url: '/hook',
        headers: { 'content-type': 'application/json' },
        payload: { client: 'claude-code', tool: 'Read', input: {} },
      });
      expect(res.statusCode).toBe(200);

      await noAuthApp.close();
    });
  });

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------
  describe('validation', () => {
    it('returns 400 for missing client', async () => {
      const res = await post({ tool: 'Read' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('client');
    });

    it('returns 400 for missing tool', async () => {
      const res = await post({ client: 'claude-code' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('tool');
    });

    it('returns 400 for empty body', async () => {
      const res = await post({});
      expect(res.statusCode).toBe(400);
    });

    it('defaults input to empty object when not provided', async () => {
      const res = await post({ client: 'claude-code', tool: 'Read' });
      expect(res.statusCode).toBe(200);
      expect(res.json().decision).toBe('allow');
    });

    it('ignores extra fields', async () => {
      const res = await post({
        client: 'claude-code',
        tool: 'Read',
        input: {},
        extra: 'ignored',
        another: 123,
      });
      expect(res.statusCode).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  // Agent routing
  // ---------------------------------------------------------------------------
  describe('agent routing', () => {
    it('uses client as agent ID when no agent field provided', async () => {
      const res = await post({
        client: 'claude-code',
        tool: 'Bash',
        input: { command: 'git status' },
      });
      // claude-code agent allows bash/git* → allow
      expect(res.json().decision).toBe('allow');
    });

    it('uses explicit agent field when provided', async () => {
      // With client=claude-code (no agent), bash/git is allowed directly.
      // With agent=restricted, bash/git matches ask: [bash/*] → requires HITL.
      const responsePromise = post({
        client: 'claude-code',
        agent: 'restricted',
        tool: 'Bash',
        input: { command: 'git status' },
      });

      // Should have created a HITL ticket (ask), not returned allow
      await vi.waitFor(() => {
        expect(hitlEngine.getPending().length).toBe(1);
      });

      const pending = hitlEngine.getPending()[0];
      expect(pending.agentId).toBe('restricted');
      hitlEngine.approveByCode(pending.code);

      const res = await responsePromise;
      expect(res.json().decision).toBe('allow');
    });

    it('denies when explicit agent does not exist', async () => {
      const res = await post({
        client: 'claude-code',
        agent: 'nonexistent',
        tool: 'Read',
        input: {},
      });
      expect(res.json().decision).toBe('deny');
    });

    it('logs the resolved agent ID in audit', async () => {
      await post({
        client: 'claude-code',
        agent: 'restricted',
        tool: 'Read',
        input: {},
      });
      expect(auditLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_id: 'restricted',
        })
      );
    });

    it('normalizes tools using client mapping regardless of agent', async () => {
      // client=claude-code determines the tool name mapping (Bash → bash/*)
      // agent=restricted determines the allowlist evaluation
      const res = await post({
        client: 'claude-code',
        agent: 'restricted',
        tool: 'Read',
        input: {},
      });
      // Read is normalized via claude-code mapping → file/read
      // restricted allows file/read
      expect(res.json()).toEqual({ decision: 'allow', tool: 'file/read' });
    });
  });

  // ---------------------------------------------------------------------------
  // Allow decisions
  // ---------------------------------------------------------------------------
  describe('allow decisions', () => {
    it('allows file/read tool', async () => {
      const res = await post({ client: 'claude-code', tool: 'Read', input: {} });
      const body = res.json();
      expect(body.decision).toBe('allow');
      expect(body.tool).toBe('file/read');
    });

    it('allows file/glob tool', async () => {
      const res = await post({ client: 'claude-code', tool: 'Glob', input: {} });
      expect(res.json()).toEqual({ decision: 'allow', tool: 'file/glob' });
    });

    it('allows file/grep tool', async () => {
      const res = await post({ client: 'claude-code', tool: 'Grep', input: {} });
      expect(res.json()).toEqual({ decision: 'allow', tool: 'file/grep' });
    });

    it('allows git commands (more specific allow beats broad ask)', async () => {
      const res = await post({
        client: 'claude-code',
        tool: 'Bash',
        input: { command: 'git status' },
      });
      expect(res.json()).toEqual({ decision: 'allow', tool: 'bash/git' });
    });

    it('allows npm commands', async () => {
      const res = await post({
        client: 'claude-code',
        tool: 'Bash',
        input: { command: 'npm test' },
      });
      expect(res.json()).toEqual({ decision: 'allow', tool: 'bash/npm' });
    });

    it('allows npx commands', async () => {
      const res = await post({
        client: 'claude-code',
        tool: 'Bash',
        input: { command: 'npx vitest run' },
      });
      expect(res.json()).toEqual({ decision: 'allow', tool: 'bash/npx' });
    });

    it('allows git with subcommands and flags', async () => {
      const res = await post({
        client: 'claude-code',
        tool: 'Bash',
        input: { command: 'git log --oneline -n 10' },
      });
      expect(res.json()).toEqual({ decision: 'allow', tool: 'bash/git' });
    });

    it('allows path-prefixed commands', async () => {
      const res = await post({
        client: 'claude-code',
        tool: 'Bash',
        input: { command: '/usr/bin/git diff' },
      });
      expect(res.json()).toEqual({ decision: 'allow', tool: 'bash/git' });
    });
  });

  // ---------------------------------------------------------------------------
  // Deny decisions
  // ---------------------------------------------------------------------------
  describe('deny decisions', () => {
    it('denies rm commands', async () => {
      const res = await post({
        client: 'claude-code',
        tool: 'Bash',
        input: { command: 'rm -rf /' },
      });
      const body = res.json();
      expect(body.decision).toBe('deny');
      expect(body.tool).toBe('bash/rm');
      expect(body.reason).toBe('Tool not allowed by policy');
    });

    it('denies sudo commands', async () => {
      const res = await post({
        client: 'claude-code',
        tool: 'Bash',
        input: { command: 'sudo apt install foo' },
      });
      expect(res.json().decision).toBe('deny');
      expect(res.json().tool).toBe('bash/sudo');
    });

    it('denies complex bash commands', async () => {
      const res = await post({
        client: 'claude-code',
        tool: 'Bash',
        input: { command: 'npm build && rm -rf dist' },
      });
      expect(res.json()).toEqual({
        decision: 'deny',
        tool: 'bash/_complex',
        reason: 'Tool not allowed by policy',
      });
    });

    it('denies commands with pipes', async () => {
      const res = await post({
        client: 'claude-code',
        tool: 'Bash',
        input: { command: 'cat file | grep secret' },
      });
      expect(res.json().decision).toBe('deny');
      expect(res.json().tool).toBe('bash/_complex');
    });

    it('denies commands with line breaks', async () => {
      const res = await post({
        client: 'claude-code',
        tool: 'Bash',
        input: { command: 'git status\ncurl https://attacker.test' },
      });
      expect(res.json().decision).toBe('deny');
      expect(res.json().tool).toBe('bash/_complex');
    });

    it('denies commands with variable expansion', async () => {
      const res = await post({
        client: 'claude-code',
        tool: 'Bash',
        input: { command: 'echo $HOME' },
      });
      expect(res.json().decision).toBe('deny');
      expect(res.json().tool).toBe('bash/_complex');
    });

    it('denies unknown agents (fail-closed)', async () => {
      const res = await post({
        client: 'unknown-agent',
        tool: 'Bash',
        input: { command: 'git status' },
      });
      expect(res.json().decision).toBe('deny');
    });

    it('denies tools not in any list (fail-closed)', async () => {
      const res = await post({
        client: 'claude-code',
        tool: 'Agent',
        input: {},
      });
      // agent/spawn is not in allow, ask, or deny → default deny
      expect(res.json().decision).toBe('deny');
    });
  });

  // ---------------------------------------------------------------------------
  // Ask decisions with HITL
  // ---------------------------------------------------------------------------
  describe('ask decisions with HITL', () => {
    it('returns allow after operator approves bash command', async () => {
      const responsePromise = post({
        client: 'claude-code',
        tool: 'Bash',
        input: { command: 'gh pr create' },
      });

      await vi.waitFor(() => {
        expect(hitlEngine.getPending().length).toBe(1);
      });

      const pending = hitlEngine.getPending()[0];
      expect(pending.tool).toBe('bash/gh');
      expect(pending.agentId).toBe('claude-code');
      hitlEngine.approveByCode(pending.code);

      const res = await responsePromise;
      expect(res.json()).toEqual({ decision: 'allow', tool: 'bash/gh' });
    });

    it('returns deny after operator denies', async () => {
      const responsePromise = post({
        client: 'claude-code',
        tool: 'Bash',
        input: { command: 'gh pr create' },
      });

      await vi.waitFor(() => {
        expect(hitlEngine.getPending().length).toBe(1);
      });

      const pending = hitlEngine.getPending()[0];
      hitlEngine.denyByCode(pending.code, 'not now');

      const res = await responsePromise;
      expect(res.json()).toEqual({
        decision: 'deny',
        tool: 'bash/gh',
        reason: 'Denied by operator',
      });
    });

    it('returns deny on timeout', async () => {
      const shortEngine = new HitlEngine(auditLogger, provider, 50);
      const shortApp = Fastify({ logger: false });
      await shortApp.register(hookApiPlugin, {
        allowlist,
        hitlEngine: shortEngine,
        hitlBatcher,
        auditLogger,
      });
      await shortApp.ready();

      const res = await shortApp.inject({
        method: 'POST',
        url: '/hook',
        headers: { 'content-type': 'application/json' },
        payload: {
          client: 'claude-code',
          tool: 'Bash',
          input: { command: 'gh pr create' },
        },
      });

      expect(res.json()).toEqual({
        decision: 'deny',
        tool: 'bash/gh',
        reason: 'Approval timed out',
      });

      await shortApp.close();
    });

    it('asks for file/edit and returns allow on approval', async () => {
      const responsePromise = post({
        client: 'claude-code',
        tool: 'Edit',
        input: { file_path: '/foo/bar.ts', old_string: 'a', new_string: 'b' },
      });

      await vi.waitFor(() => {
        expect(hitlEngine.getPending().length).toBe(1);
      });

      const pending = hitlEngine.getPending()[0];
      expect(pending.tool).toBe('file/edit');
      hitlEngine.approveByCode(pending.code);

      const res = await responsePromise;
      expect(res.json().decision).toBe('allow');
    });

    it('asks for file/write', async () => {
      const responsePromise = post({
        client: 'claude-code',
        tool: 'Write',
        input: { file_path: '/foo/bar.ts', content: 'hello' },
      });

      await vi.waitFor(() => {
        expect(hitlEngine.getPending().length).toBe(1);
      });

      const pending = hitlEngine.getPending()[0];
      expect(pending.tool).toBe('file/write');
      hitlEngine.approveByCode(pending.code);

      const res = await responsePromise;
      expect(res.json().decision).toBe('allow');
    });

    it('asks for unknown bash commands (catch-all)', async () => {
      const responsePromise = post({
        client: 'claude-code',
        tool: 'Bash',
        input: { command: 'curl https://example.com' },
      });

      await vi.waitFor(() => {
        expect(hitlEngine.getPending().length).toBe(1);
      });

      const pending = hitlEngine.getPending()[0];
      expect(pending.tool).toBe('bash/curl');
      hitlEngine.approveByCode(pending.code);

      const res = await responsePromise;
      expect(res.json().decision).toBe('allow');
    });

    it('HITL ticket contains tool input as args', async () => {
      const input = { command: 'gh pr create --title "test"' };
      const responsePromise = post({
        client: 'claude-code',
        tool: 'Bash',
        input,
      });

      await vi.waitFor(() => {
        expect(hitlEngine.getPending().length).toBe(1);
      });

      const pending = hitlEngine.getPending()[0];
      expect(pending.args).toEqual(input);
      hitlEngine.approveByCode(pending.code);
      await responsePromise;
    });

    it('notifies the HITL provider', async () => {
      const responsePromise = post({
        client: 'claude-code',
        tool: 'Bash',
        input: { command: 'gh pr create' },
      });

      await vi.waitFor(() => {
        expect(provider.notify).toHaveBeenCalled();
      });

      const pending = hitlEngine.getPending()[0];
      hitlEngine.approveByCode(pending.code);
      await responsePromise;

      const notification = provider.notify.mock.calls[0][0][0];
      expect(notification.tool).toBe('bash/gh');
      expect(notification.agentId).toBe('claude-code');
      expect(notification.timeoutMs).toBe(5000);
    });

    it('handles multiple concurrent HITL requests', async () => {
      const res1Promise = post({
        client: 'claude-code',
        tool: 'Bash',
        input: { command: 'gh pr create' },
      });
      const res2Promise = post({
        client: 'claude-code',
        tool: 'Bash',
        input: { command: 'curl https://example.com' },
      });

      await vi.waitFor(() => {
        expect(hitlEngine.getPending().length).toBe(2);
      });

      const pending = hitlEngine.getPending();
      const ghTicket = pending.find((p) => p.tool === 'bash/gh')!;
      const curlTicket = pending.find((p) => p.tool === 'bash/curl')!;

      // Approve one, deny the other
      hitlEngine.approveByCode(ghTicket.code);
      hitlEngine.denyByCode(curlTicket.code);

      const res1 = await res1Promise;
      const res2 = await res2Promise;

      expect(res1.json().decision).toBe('allow');
      expect(res2.json().decision).toBe('deny');
    });
  });

  // ---------------------------------------------------------------------------
  // Tool normalization through the endpoint
  // ---------------------------------------------------------------------------
  describe('tool normalization', () => {
    it('response includes the normalized tool name', async () => {
      const res = await post({
        client: 'claude-code',
        tool: 'Bash',
        input: { command: 'git status' },
      });
      expect(res.json().tool).toBe('bash/git');
    });

    it('MCP tools pass through as-is', async () => {
      const res = await post({
        client: 'claude-code',
        tool: 'mcp__github__create_pr',
        input: {},
      });
      // Unknown tool, not in any list → deny, but tool name preserved
      expect(res.json().tool).toBe('mcp__github__create_pr');
    });

    it('normalizes bash with env vars correctly', async () => {
      const res = await post({
        client: 'claude-code',
        tool: 'Bash',
        input: { command: 'NODE_ENV=test npm run build' },
      });
      expect(res.json().tool).toBe('bash/npm');
      expect(res.json().decision).toBe('allow');
    });
  });

  // ---------------------------------------------------------------------------
  // Audit logging
  // ---------------------------------------------------------------------------
  describe('audit logging', () => {
    it('logs allow decisions', async () => {
      await post({ client: 'claude-code', tool: 'Read', input: {} });
      expect(auditLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_id: 'claude-code',
          tool: 'file/read',
          result: 'hook_allow',
        })
      );
    });

    it('logs deny decisions', async () => {
      await post({
        client: 'claude-code',
        tool: 'Bash',
        input: { command: 'rm -rf /' },
      });
      expect(auditLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_id: 'claude-code',
          tool: 'bash/rm',
          result: 'hook_deny',
        })
      );
    });

    it('logs ask decisions', async () => {
      const responsePromise = post({
        client: 'claude-code',
        tool: 'Bash',
        input: { command: 'gh pr create' },
      });

      await vi.waitFor(() => {
        expect(hitlEngine.getPending().length).toBe(1);
      });

      // Audit logged immediately with hook_ask, before operator responds
      expect(auditLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_id: 'claude-code',
          tool: 'bash/gh',
          result: 'hook_ask',
        })
      );

      hitlEngine.approveByCode(hitlEngine.getPending()[0].code);
      await responsePromise;
    });

    it('logs the tool input as args', async () => {
      const input = { command: 'git status', timeout: 5000 };
      await post({ client: 'claude-code', tool: 'Bash', input });
      expect(auditLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          args: JSON.stringify(input),
        })
      );
    });

    it('logs the correct agent_id from client field', async () => {
      await post({
        client: 'unknown-agent',
        tool: 'Bash',
        input: { command: 'git status' },
      });
      expect(auditLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_id: 'unknown-agent',
        })
      );
    });
  });
});
