import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { createConfigureWebApp, upsertProvider } from '../src/configure-web/cli.js';

const CONFIG = `
providers:
  exec:
    type: builtin
    instructions: Run read-only commands only.
agents:
  dev:
    allow: []
    ask:
      - exec/run
approvals:
  provider:
    type: stdio
`;

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'airlock-cli-web-'));
  configPath = join(dir, 'airlock.yaml');
  writeFileSync(configPath, CONFIG);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('/api/meta approvals flag', () => {
  it('is false for the standalone command center, which has no approval routes', async () => {
    const app = createConfigureWebApp(configPath);
    await app.ready();
    expect((await app.inject('/api/meta')).json()).toMatchObject({ approvals: false });
    expect((await app.inject({ method: 'POST', url: '/approve?code=X' })).statusCode).toBe(404);
    await app.close();
  });

  it('is true when approval routes are mounted or a gateway is proxied', async () => {
    const withApprovals = createConfigureWebApp(configPath, {
      approvals: { registerRoutes: () => {} },
    });
    const remote = createConfigureWebApp(configPath, {
      remoteGateway: { url: 'http://gateway:4113' },
    });
    for (const app of [withApprovals, remote]) {
      await app.ready();
      expect((await app.inject('/api/meta')).json()).toMatchObject({ approvals: true });
      await app.close();
    }
  });
});

describe('upsertProvider() built-ins', () => {
  it('keeps a built-in provider’s other fields across a toggle', () => {
    upsertProvider(configPath, { id: 'exec', type: 'builtin', enabled: false });
    let providers = parseYaml(readFileSync(configPath, 'utf8')).providers;
    expect(providers.exec).toEqual({
      type: 'builtin',
      instructions: 'Run read-only commands only.',
      enabled: false,
    });

    upsertProvider(configPath, { id: 'exec', type: 'builtin', enabled: true });
    providers = parseYaml(readFileSync(configPath, 'utf8')).providers;
    expect(providers.exec).toEqual({
      type: 'builtin',
      instructions: 'Run read-only commands only.',
    });
  });

  it('still writes the short form when there is nothing else to keep', () => {
    upsertProvider(configPath, { id: 'http', type: 'builtin', enabled: true });
    expect(parseYaml(readFileSync(configPath, 'utf8')).providers.http).toBe('builtin');
  });
});

interface Call {
  url: string;
  method?: string;
}

function mockGateway(options: {
  pending?: Record<string, unknown>[];
  approve?: () => Response;
  tools?: { name: string }[];
}): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method });
    if (url.endsWith('/health')) {
      return Response.json({ mcpHealth: { exec: 'ok' }, pendingApprovals: 0 });
    }
    if (url.endsWith('/admin/tools')) return Response.json({ tools: options.tools ?? [] });
    if (url.endsWith('/hitl/pending')) return Response.json(options.pending ?? []);
    if (url.includes('/approve?')) return options.approve?.() ?? Response.json({ ok: true });
    if (url.includes('/deny?')) return Response.json({ ok: true });
    return Response.json({ error: 'not found' }, { status: 404 });
  });
  return calls;
}

const PENDING = {
  id: 'req-1',
  code: 'ABC123',
  agentId: 'dev',
  tool: 'exec/run',
  args: {},
};

async function remoteApp() {
  const app = createConfigureWebApp(configPath, {
    remoteGateway: { url: 'http://gateway:4113', secret: 'admin-secret' },
  });
  await app.ready();
  return app;
}

describe('remote dashboard /approve', () => {
  it('forwards grant parameters and remember=temporary to the gateway untouched', async () => {
    const calls = mockGateway({ pending: [PENDING] });
    const app = await remoteApp();

    const res = await app.inject({
      method: 'POST',
      url: '/approve?code=ABC123&remember=temporary&duration_ms=3600000&grant_scope=tier&grant_tier=read&max_uses=3',
    });
    expect(res.statusCode).toBe(200);
    const forwarded = new URL(calls.find((call) => call.url.includes('/approve?'))!.url);
    expect(Object.fromEntries(forwarded.searchParams)).toEqual({
      code: 'ABC123',
      remember: 'temporary',
      duration_ms: '3600000',
      grant_scope: 'tier',
      grant_tier: 'read',
      max_uses: '3',
    });
    // A temporary allow is the gateway's grant, not a rule in this dashboard's config.
    expect(readFileSync(configPath, 'utf8')).not.toContain('remember_allow');
    await app.close();
  });

  it('keeps remember=always local and writes it only after the gateway approved', async () => {
    const calls = mockGateway({ pending: [PENDING] });
    const app = await remoteApp();

    const res = await app.inject({ method: 'POST', url: '/approve?code=ABC123&remember=always' });
    expect(res.statusCode).toBe(200);
    const forwarded = new URL(calls.find((call) => call.url.includes('/approve?'))!.url);
    expect(forwarded.searchParams.get('remember')).toBeNull();
    const agent = parseYaml(readFileSync(configPath, 'utf8')).agents.dev;
    expect(agent.allow).toContain('exec/run');
    await app.close();
  });

  it('leaves the config alone when the gateway refuses the approval', async () => {
    mockGateway({
      pending: [PENDING],
      approve: () => Response.json({ error: 'Grant scope is not allowed' }, { status: 400 }),
    });
    const app = await remoteApp();

    const res = await app.inject({ method: 'POST', url: '/approve?code=ABC123&remember=always' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Grant scope is not allowed' });
    expect(readFileSync(configPath, 'utf8')).toBe(CONFIG);
    await app.close();
  });

  it('refuses to remember an escalated request or an unknown mode, without approving', async () => {
    const calls = mockGateway({ pending: [{ ...PENDING, escalated: true }] });
    const app = await remoteApp();

    const escalated = await app.inject({
      method: 'POST',
      url: '/approve?code=ABC123&remember=always',
    });
    expect(escalated.statusCode).toBe(400);
    const invalid = await app.inject({
      method: 'POST',
      url: '/approve?code=ABC123&remember=forever',
    });
    expect(invalid.statusCode).toBe(400);
    const missing = await app.inject({ method: 'POST', url: '/approve?code=NOPE&remember=always' });
    expect(missing.statusCode).toBe(404);
    const noCode = await app.inject({ method: 'POST', url: '/approve' });
    expect(noCode.statusCode).toBe(400);

    expect(calls.some((call) => call.url.includes('/approve?'))).toBe(false);
    expect(readFileSync(configPath, 'utf8')).toBe(CONFIG);
    await app.close();
  });
});

describe('remote dashboard /api/status', () => {
  it('reports tool counts from the gateway catalog', async () => {
    mockGateway({ tools: [{ name: 'exec/run' }, { name: 'airlock/ask_user' }] });
    const app = await remoteApp();

    const status = (await app.inject('/api/status')).json();
    expect(status.providers).toEqual([
      expect.objectContaining({ id: 'exec', toolCount: 1, toolFingerprint: 'exec/run' }),
    ]);
    expect(status.summary.tools).toBe(1);
    await app.close();
  });
});
