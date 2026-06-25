import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import {
  annotationTags,
  assertSafeWebBindHost,
  createConfigureWebApp,
  createEntity,
  deleteProvider,
  readAuditLogs,
  readCommandCenterStatus,
  readState,
  recommendedDecision,
  resolveEditableRuleDecision,
  resolveEditableRuleMatch,
  saveRules,
  toolFingerprint,
  upsertProvider,
} from '../src/configure-web/cli.js';
import { AuditDb } from '../src/audit/db.js';
import { ApprovalDashboardRoutes } from '../src/hitl/approval-dashboard.js';
import { ApprovalStreamHub } from '../src/hitl/approval-stream.js';

describe('configure-web config helpers', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'airlock-web-'));
    configPath = join(dir, 'airlock.yaml');
    writeFileSync(
      configPath,
      `
providers:
  exec: builtin
  old:
    type: stdio
    enabled: false
    command: echo
profiles:
  readonly:
    allow:
      - exec/run
    deny:
      - exec/danger
  writer:
    extends:
      - readonly
    allow:
      - exec/write
agents:
  dev:
    extends:
      - readonly
    allow: []
    ask: []
    deny: []
approvals:
  provider:
    type: stdio
`
    );
  });

  it('requires an explicit insecure flag for non-loopback web UI binds', () => {
    expect(() => assertSafeWebBindHost('127.0.0.1', false)).not.toThrow();
    expect(() => assertSafeWebBindHost('localhost', false)).not.toThrow();
    expect(() => assertSafeWebBindHost('0.0.0.0', false)).toThrow(/insecure-remote-bind/);
    expect(() => assertSafeWebBindHost('0.0.0.0', true)).not.toThrow();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads editable agents and profiles without applying inheritance', () => {
    const state = readState(configPath);

    expect(state.providers.exec).toEqual({ type: 'builtin', enabled: true });
    expect(state.providers.old).toMatchObject({ type: 'stdio', enabled: false, command: 'echo' });
    expect(state.agents.dev.extends).toEqual(['readonly']);
    expect(state.profiles.readonly.allow).toEqual(['exec/run']);
    expect(state.profiles.readonly.deny).toEqual(['exec/danger']);
    expect(state.profiles.writer.extends).toEqual(['readonly']);
  });

  it('saves only editable agent rule fields and keeps backups', () => {
    saveRules(configPath, {
      kind: 'agent',
      id: 'dev',
      extends: [],
      allow: ['exec/run'],
      ask: [],
      deny: ['exec/danger'],
    });

    const parsed = parseYaml(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const agents = parsed.agents as Record<string, Record<string, unknown>>;

    expect(agents.dev.allow).toEqual(['exec/run']);
    expect(agents.dev.deny).toEqual(['exec/danger']);
    expect(readFileSync(join(dir, 'airlock.bak'), 'utf8')).toContain('readonly');
  });

  it('creates empty profiles', () => {
    const state = createEntity(configPath, { kind: 'profile', id: 'release' });

    expect(state.profiles.release).toEqual({ extends: [], allow: [], ask: [], deny: [] });
  });

  it('creates agents with a secure bearer token', () => {
    const state = createEntity(configPath, {
      kind: 'agent',
      id: 'codex',
      profileIds: ['readonly'],
    }) as ReturnType<typeof createEntity> & {
      createdToken?: { agentId: string; token: string };
    };

    const parsed = parseYaml(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const agents = parsed.agents as Record<string, Record<string, unknown>>;

    expect(state.createdToken?.agentId).toBe('codex');
    expect(state.createdToken?.token).toMatch(/^airlock_agent_[A-Za-z0-9_-]{43}$/);
    expect(agents.codex.token).toBe(state.createdToken?.token);
    expect(agents.codex.extends).toEqual(['readonly']);
    expect(state.agents.codex.hasToken).toBe(true);
  });

  it('does not reuse a cloned agent token', () => {
    const first = createEntity(configPath, { kind: 'agent', id: 'codex' }) as ReturnType<
      typeof createEntity
    > & { createdToken?: { token: string } };
    const second = createEntity(configPath, {
      kind: 'agent',
      id: 'cursor',
      baseId: 'codex',
    }) as ReturnType<typeof createEntity> & { createdToken?: { token: string } };

    const parsed = parseYaml(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const agents = parsed.agents as Record<string, Record<string, unknown>>;

    expect(second.createdToken?.token).toMatch(/^airlock_agent_[A-Za-z0-9_-]{43}$/);
    expect(second.createdToken?.token).not.toBe(first.createdToken?.token);
    expect(agents.cursor.token).toBe(second.createdToken?.token);
  });

  it('saves profile inheritance and deny rules', () => {
    const state = saveRules(configPath, {
      kind: 'profile',
      id: 'writer',
      extends: ['readonly'],
      allow: ['exec/write'],
      ask: [],
      deny: ['exec/danger'],
    });

    expect(state.profiles.writer.extends).toEqual(['readonly']);
    expect(state.profiles.writer.deny).toEqual(['exec/danger']);
  });

  it('adds and disables providers without dropping connection fields', () => {
    const added = upsertProvider(configPath, {
      id: 'echo',
      type: 'stdio',
      enabled: true,
      command: 'node',
      args: ['server.js'],
    });
    expect(added.providers.echo).toMatchObject({
      type: 'stdio',
      enabled: true,
      command: 'node',
      args: ['server.js'],
    });

    const disabled = upsertProvider(configPath, {
      id: 'echo',
      type: 'stdio',
      enabled: false,
    });
    expect(disabled.providers.echo).toMatchObject({
      type: 'stdio',
      enabled: false,
      command: 'node',
      args: ['server.js'],
    });
  });

  it('deletes providers', () => {
    const state = deleteProvider(configPath, 'old');

    expect(state.providers.old).toBeUndefined();
  });

  it('reports command center provider status without connecting disabled providers', async () => {
    const status = await readCommandCenterStatus(configPath);

    expect(status.summary.ok).toBe(1);
    expect(status.summary.disabled).toBe(1);
    expect(status.summary.tools).toBeGreaterThanOrEqual(1);
    expect(status.summary.pendingApprovals).toBe(0);
    expect(status.providers.find((provider) => provider.id === 'exec')).toMatchObject({
      type: 'builtin',
      enabled: true,
      status: 'ok',
      toolCount: 1,
      toolFingerprint: 'exec/run',
    });
    expect(status.providers.find((provider) => provider.id === 'old')).toMatchObject({
      type: 'stdio',
      enabled: false,
      status: 'disabled',
      toolCount: 0,
      toolFingerprint: '',
    });
  });

  it('keeps provider config errors scoped to the broken provider', async () => {
    writeFileSync(
      configPath,
      `
providers:
  exec: builtin
  broken:
    type: stdio
    command: \${MISSING_AIRLOCK_TEST_COMMAND}
agents:
  dev:
    allow: []
approvals:
  provider:
    type: stdio
`
    );

    const status = await readCommandCenterStatus(configPath);

    expect(status.providers.find((provider) => provider.id === 'exec')).toMatchObject({
      status: 'ok',
      toolFingerprint: 'exec/run',
    });
    expect(status.providers.find((provider) => provider.id === 'broken')).toMatchObject({
      status: 'down',
    });
  });

  it('reads audit logs from the configured audit database', () => {
    const auditPath = join(dir, 'audit.db');
    writeFileSync(
      configPath,
      readFileSync(configPath, 'utf8') +
        `
audit:
  db_path: ${JSON.stringify(auditPath)}
`
    );
    const db = new AuditDb(auditPath);
    db.insertAudit({
      ts: '2026-05-24T10:00:00.000Z',
      agent_id: 'dev',
      tool: 'exec/run',
      args: '{"command":"pwd"}',
      result: 'success',
    });
    db.insertHitl({
      id: 'req-1',
      code: 'ABC123',
      agent_id: 'dev',
      tool: 'exec/run',
      args: '{"command":"git status"}',
      status: 'pending',
      created_at: '2026-05-24T10:01:00.000Z',
    });
    db.close();

    const logs = readAuditLogs(configPath, { agent: 'dev', limit: 10 });

    expect(logs.dbPath).toBe(auditPath);
    expect(logs.entries).toHaveLength(1);
    expect(logs.entries[0]).toMatchObject({ agent_id: 'dev', tool: 'exec/run' });
    expect(logs.pending).toHaveLength(1);
  });

  it('fingerprints tool names so renames are detected even when counts match', () => {
    expect(toolFingerprint(['github/create_issue', 'github/create_pr'])).toBe(
      toolFingerprint(['github/create_pr', 'github/create_issue'])
    );
    expect(toolFingerprint(['github/create_pr'])).not.toBe(toolFingerprint(['github/merge_pr']));
  });

  it('matches configure-agent recommendation rules', () => {
    expect(recommendedDecision({ destructiveHint: true })).toBe('ask');
    expect(recommendedDecision({ openWorldHint: true })).toBe('ask');
    expect(recommendedDecision({ readOnlyHint: true })).toBe('allow');
    expect(recommendedDecision({}, ['override\\s+(all\\s+)?instructions?'])).toBe('deny');
    expect(
      annotationTags({ readOnlyHint: true, openWorldHint: true }, [
        'override\\s+(all\\s+)?instructions?',
      ])
    ).toEqual(['readonly', 'open-world', 'injection']);
  });

  it('resolves visible rule decisions with wildcard specificity', () => {
    const rules = {
      allow: ['ticktick/*'],
      ask: ['ticktick/delete_task'],
      deny: ['github/*'],
    };

    expect(resolveEditableRuleDecision(rules, 'ticktick/create_task')).toBe('allow');
    expect(resolveEditableRuleDecision(rules, 'ticktick/delete_task')).toBe('ask');
    expect(resolveEditableRuleDecision(rules, 'github/create_pr')).toBe('deny');
    expect(resolveEditableRuleDecision(rules, 'ticktick/project/archive')).toBe('unset');
  });

  it('reports whether visible rule decisions came from exact rules or patterns', () => {
    const rules = {
      allow: ['ticktick/*', 'github/create_pr'],
      ask: [],
      deny: [],
    };

    expect(resolveEditableRuleMatch(rules, 'ticktick/create_task')).toEqual({
      decision: 'allow',
      source: 'pattern',
      pattern: 'ticktick/*',
    });
    expect(resolveEditableRuleMatch(rules, 'github/create_pr')).toEqual({
      decision: 'allow',
      source: 'exact',
      pattern: 'github/create_pr',
    });
    expect(resolveEditableRuleMatch(rules, 'slack/post_message')).toEqual({
      decision: 'unset',
      source: 'none',
    });
  });
});

describe('configure-web API', () => {
  it('serves state and builtin tools', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'airlock-web-api-'));
    const configPath = join(dir, 'airlock.yaml');
    writeFileSync(
      configPath,
      `
providers:
  exec: builtin
  disabled-bad:
    type: stdio
    enabled: false
    command: definitely-not-a-command
agents:
  dev:
    allow: []
approvals:
  provider:
    type: stdio
`
    );

    const app = createConfigureWebApp(configPath);
    await app.ready();

    const stateRes = await app.inject('/api/state');
    expect(stateRes.statusCode).toBe(200);
    expect(stateRes.json().agents.dev).toBeTruthy();
    expect(stateRes.json().providers.exec).toEqual({ type: 'builtin', enabled: true });

    const toolsRes = await app.inject('/api/tools');
    expect(toolsRes.statusCode).toBe(200);
    expect(toolsRes.json().tools.map((tool: { name: string }) => tool.name)).toContain('exec/run');
    expect(toolsRes.json().errors).not.toContain(expect.stringContaining('disabled-bad'));
    expect(
      toolsRes.json().tools.find((tool: { name: string }) => tool.name === 'exec/run')
    ).toMatchObject({
      tags: [],
      recommended: 'allow',
      suspiciousPatterns: [],
    });

    const statusRes = await app.inject('/api/status');
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json().summary).toMatchObject({ pendingApprovals: 0 });
    expect(statusRes.json().providers).toContainEqual(
      expect.objectContaining({
        id: 'exec',
        status: 'ok',
        toolCount: 1,
        toolFingerprint: 'exec/run',
      })
    );
    expect(statusRes.json().providers).toContainEqual(
      expect.objectContaining({ id: 'disabled-bad', status: 'disabled' })
    );

    const logsRes = await app.inject('/api/logs');
    expect(logsRes.statusCode).toBe(200);
    expect(logsRes.json()).toMatchObject({ entries: [], pending: [] });

    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('can host live approval routes alongside the command center', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'airlock-web-approvals-'));
    const configPath = join(dir, 'airlock.yaml');
    writeFileSync(
      configPath,
      `
providers:
  exec: builtin
agents:
  dev:
    allow: []
approvals:
  provider:
    type: dashboard
`
    );

    const approved: string[] = [];
    const denied: string[] = [];
    const stream = new ApprovalStreamHub();
    const approvals = new ApprovalDashboardRoutes(
      {
        approve: () => {},
        deny: () => {},
        approveByCode: (code) => approved.push(code),
        denyByCode: (code) => denied.push(code),
      },
      stream
    );
    await stream.notify([
      {
        id: 'req-1',
        code: 'ABC123',
        agentId: 'dev',
        tool: 'exec/run',
        args: { command: 'pwd' },
        timeoutMs: 300000,
      },
    ]);
    const app = createConfigureWebApp(configPath, { approvals });
    await app.ready();

    const pageRes = await app.inject('/');
    expect(pageRes.statusCode).toBe(200);
    expect(pageRes.body).toContain('Airlock Command Center');

    const approveRes = await app.inject({
      method: 'POST',
      url: '/approve?code=ABC123&remember=always',
    });
    expect(approveRes.statusCode).toBe(200);
    expect(approved).toEqual(['ABC123']);
    expect(denied).toEqual([]);
    expect(readFileSync(configPath, 'utf8')).toContain('remember_allow');

    const denyRes = await app.inject({ method: 'POST', url: '/deny?code=DEF456' });
    expect(denyRes.statusCode).toBe(200);
    expect(denied).toEqual(['DEF456']);

    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('can run as a remote dashboard client while mutating local config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'airlock-web-remote-'));
    const configPath = join(dir, 'airlock.yaml');
    writeFileSync(
      configPath,
      `
providers:
  exec: builtin
agents:
  dev:
    allow: []
    ask:
      - exec/run
approvals:
  provider:
    type: stdio
`
    );

    const calls: Array<{ url: string; auth?: string; method?: string }> = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, auth: headers.get('authorization') ?? undefined, method: init?.method });
      if (url.endsWith('/health')) {
        return Response.json({ mcpHealth: {}, pendingApprovals: 1 });
      }
      if (url.includes('/audit')) {
        return Response.json([]);
      }
      if (url.endsWith('/hitl/pending')) {
        return Response.json([
          {
            id: 'req-1',
            code: 'ABC123',
            agentId: 'dev',
            tool: 'exec/run',
            args: { command: 'pwd' },
          },
        ]);
      }
      if (url.endsWith('/admin/tools')) {
        return Response.json({
          tools: [{ name: 'exec/run', inputSchema: { type: 'object' } }],
          errors: [],
        });
      }
      if (url.includes('/approve?')) {
        return Response.json({ ok: true });
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    });

    const app = createConfigureWebApp(configPath, {
      remoteGateway: { url: 'http://gateway:4113', secret: 'admin-secret' },
    });
    await app.ready();

    expect((await app.inject('/api/status')).json()).toMatchObject({
      summary: { pendingApprovals: 1 },
    });
    expect((await app.inject('/api/logs')).json()).toMatchObject({
      dbPath: 'gateway:http://gateway:4113',
      pending: [expect.objectContaining({ code: 'ABC123', agent_id: 'dev' })],
    });
    expect((await app.inject('/api/tools')).json()).toMatchObject({
      tools: [expect.objectContaining({ name: 'exec/run' })],
    });

    const approveRes = await app.inject({
      method: 'POST',
      url: '/approve?code=ABC123&remember=always',
    });
    expect(approveRes.statusCode).toBe(200);
    expect(readFileSync(configPath, 'utf8')).toContain('remember_allow');
    expect(calls.every((call) => call.auth === 'Bearer admin-secret')).toBe(true);

    await app.close();
    fetchSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });
});
