/**
 * OAuth grant lifecycle against an in-process fake authorization server (AS), protected-resource
 * metadata (PRM) and MCP resource server.
 *
 * Every incident class that cost a real grant is reproduced here, and every case ends by asserting
 * that the token file on disk still holds a grant the AS would accept:
 *   - rotating refresh tokens across many cycles, and across a gateway restart
 *   - refresh responses that omit refresh_token
 *   - transient 5xx / timeouts on the token endpoint
 *   - PRM / AS-metadata outage during refresh (must still send the authorization-time `resource`)
 *   - issuer URL change (e.g. https://clerk.x → https://x/_clerk)
 *   - invalid_grant: grant retained, exponential backoff, recovery when the AS recovers
 *   - a second process (CLI) sharing the store: cannot refresh, write, or wipe
 *   - app-level expiry (no HTTP 401): proactive refresh keeps the provider working
 *   - concurrent proactive + reactive refresh: one token request (single-flight)
 */
import { createServer, type IncomingMessage, type Server as HttpServer } from 'http';
import { createServer as createNetServer } from 'net';
import { spawn } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { hostname, tmpdir } from 'os';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { auth } from '@modelcontextprotocol/client';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: execFileMock,
}));

const { HttpMcpClient } = await import('../src/pool/http-client.js');
const { FileOAuthProvider } = await import('../src/pool/oauth-provider.js');
const { refreshGrant, setOAuthRequestTimeout } = await import('../src/pool/oauth-refresh.js');
const { oauthCommand } = await import('../src/pool/oauth-cli.js');
const { HISTORY_LIMIT } = await import('../src/pool/oauth-store.js');
const { WRITER_LOCK_FILE } = await import('../src/pool/oauth-lock.js');

type Client = InstanceType<typeof HttpMcpClient>;
type Internals = { proactiveRefresh(): Promise<void> };

// ─── Fake OAuth world ────────────────────────────────────────────────────────────────────────────

interface TokenRequestLog {
  endpoint: string;
  grantType: string | null;
  refreshToken: string | null;
  resource: string | null;
  clientId: string | null;
}

type InjectedFailure = 500 | 503 | 'hang' | 'reset' | 'garbage';

class FakeOAuthWorld {
  server!: HttpServer;
  base = '';
  /** Path of the current issuer ('' = origin root). */
  issuerPath = '';
  readonly clientId = 'client-1';
  accessTtlSec = 3600;
  rotate = true;
  omitRefreshToken = false;
  requireResource = true;
  prmDown = false;
  asMetadataDown = false;
  /** Issuers (full URL) whose token endpoint answers invalid_grant for every refresh. */
  rejectingIssuers = new Set<string>();
  failures: InjectedFailure[] = [];
  tokenDelayMs = 0;
  /** `401`: expired access → HTTP 401. `app`: expired access → tool error result, no 401. */
  expiryStyle: '401' | 'app' = '401';

  readonly validRefresh = new Map<string, { clientId: string }>();
  readonly access = new Map<string, { expiresAt: number }>();
  readonly codes = new Map<string, { clientId: string; challenge: string; redirectUri: string }>();
  readonly tokenRequests: TokenRequestLog[] = [];
  refreshReuseAttempts = 0;
  unauthorizedResponses = 0;
  toolCalls = 0;

  get mcpUrl(): string {
    return `${this.base}/mcp`;
  }

  issuerFor(path: string): string {
    return `${this.base}${path}`;
  }

  get issuer(): string {
    return this.issuerFor(this.issuerPath);
  }

  async start(): Promise<void> {
    const mcp = toNodeHandler(
      createMcpHandler(() => this.mcpServer(), { legacy: 'stateless', responseMode: 'json' })
    );
    this.server = createServer((req, res) => {
      void this.route(req, res, mcp).catch((err: unknown) => {
        if (!res.headersSent) res.writeHead(500);
        res.end(String(err));
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as { port: number };
    this.base = `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  issueGrant(): { access: string; refresh: string } {
    const access = `at-${randomUUID()}`;
    const refresh = `rt-${randomUUID()}`;
    this.access.set(access, { expiresAt: Date.now() + this.accessTtlSec * 1000 });
    this.validRefresh.set(refresh, { clientId: this.clientId });
    return { access, refresh };
  }

  expireAccessTokens(): void {
    for (const entry of this.access.values()) entry.expiresAt = 0;
  }

  revokeAccessTokens(): void {
    this.access.clear();
  }

  metadataFor(path: string): Record<string, unknown> {
    const issuer = this.issuerFor(path);
    return {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    };
  }

  prm(): Record<string, unknown> {
    return { resource: this.mcpUrl, authorization_servers: [this.issuer] };
  }

  /** What a successful authorization would have persisted as discovery state. */
  discoveryState(): Record<string, unknown> {
    return {
      authorizationServerUrl: this.issuer,
      resourceMetadata: this.prm(),
      authorizationServerMetadata: this.metadataFor(this.issuerPath),
    };
  }

  private mcpServer(): Server {
    const server = new Server({ name: 'fake', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', () => ({
      tools: [{ name: 'echo', inputSchema: { type: 'object' as const } }],
    }));
    server.setRequestHandler('tools/call', (_request, ctx) => {
      this.toolCalls++;
      const token = (ctx.http?.authInfo as { token?: string } | undefined)?.token;
      const entry = token ? this.access.get(token) : undefined;
      if (!entry || entry.expiresAt <= Date.now()) {
        // App-level expiry: the server answers 200 with an error result instead of 401.
        return {
          isError: true,
          content: [{ type: 'text' as const, text: 'access token expired' }],
        };
      }
      return { content: [{ type: 'text' as const, text: `ok:${this.toolCalls}` }] };
    });
    return server;
  }

  private async route(
    req: IncomingMessage,
    res: import('http').ServerResponse,
    mcp: ReturnType<typeof toNodeHandler>
  ): Promise<void> {
    const url = new URL(req.url ?? '/', this.base);
    const path = url.pathname;
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (path.startsWith('/.well-known/oauth-protected-resource')) {
      if (this.prmDown) return json(503, { error: 'unavailable' });
      return json(200, this.prm());
    }
    if (path.startsWith('/.well-known/oauth-authorization-server')) {
      if (this.asMetadataDown) return json(503, { error: 'unavailable' });
      const suffix = path.slice('/.well-known/oauth-authorization-server'.length);
      if (suffix === '' || suffix === '/_clerk') return json(200, this.metadataFor(suffix));
      return json(404, {});
    }
    if (path.startsWith('/.well-known/')) return json(404, {});

    if (req.method === 'POST' && (path === '/register' || path === '/_clerk/register')) {
      let raw = '';
      for await (const chunk of req) raw += String(chunk);
      const metadata = JSON.parse(raw) as Record<string, unknown>;
      return json(201, { ...metadata, client_id: `registered-${randomUUID()}` });
    }
    if (req.method === 'POST' && (path === '/token' || path === '/_clerk/token')) {
      return this.token(req, res, path === '/token' ? '' : '/_clerk', json);
    }

    if (path === '/mcp') {
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }
      const header = req.headers.authorization ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : undefined;
      const entry = token ? this.access.get(token) : undefined;
      const expired = entry !== undefined && entry.expiresAt <= Date.now();
      if (!entry || (expired && this.expiryStyle === '401')) {
        this.unauthorizedResponses++;
        res.writeHead(401, {
          'WWW-Authenticate': `Bearer resource_metadata="${this.base}/.well-known/oauth-protected-resource/mcp"`,
        });
        res.end();
        return;
      }
      (req as IncomingMessage & { auth?: unknown }).auth = {
        token,
        clientId: this.clientId,
        scopes: [],
      };
      return mcp(req, res);
    }

    res.writeHead(404);
    res.end();
  }

  private async token(
    req: IncomingMessage,
    res: import('http').ServerResponse,
    issuerPath: string,
    json: (status: number, body: unknown) => void
  ): Promise<void> {
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const form = new URLSearchParams(raw);
    this.tokenRequests.push({
      endpoint: issuerPath || '/',
      grantType: form.get('grant_type'),
      refreshToken: form.get('refresh_token'),
      resource: form.get('resource'),
      clientId: form.get('client_id'),
    });
    if (this.tokenDelayMs) await new Promise((r) => setTimeout(r, this.tokenDelayMs));

    const failure = this.failures.shift();
    if (failure === 'hang') return; // never answer
    if (failure === 'reset') {
      req.socket.destroy();
      return;
    }
    if (failure === 'garbage') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>maintenance</html>');
      return;
    }
    if (failure) return json(failure, { error: 'server_error' });

    if (form.get('client_id') !== this.clientId) {
      return json(401, { error: 'invalid_client', error_description: 'unknown client' });
    }
    if (this.requireResource && form.get('resource') !== this.mcpUrl) {
      return json(400, {
        error: 'invalid_target',
        error_description: 'resource indicator is missing, or unknown',
      });
    }

    if (form.get('grant_type') === 'authorization_code') {
      const code = this.codes.get(form.get('code') ?? '');
      const verifier = form.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (!code || code.challenge !== challenge || code.redirectUri !== form.get('redirect_uri')) {
        return json(400, { error: 'invalid_grant', error_description: 'bad code' });
      }
      this.codes.delete(form.get('code') ?? '');
      const { access, refresh } = this.issueGrant();
      return json(200, {
        access_token: access,
        token_type: 'Bearer',
        refresh_token: refresh,
        expires_in: this.accessTtlSec,
      });
    }

    if (form.get('grant_type') !== 'refresh_token')
      return json(400, { error: 'unsupported_grant_type' });
    if (this.rejectingIssuers.has(this.issuerFor(issuerPath))) {
      return json(400, { error: 'invalid_grant', error_description: 'refresh token rejected' });
    }
    const presented = form.get('refresh_token') ?? '';
    if (!this.validRefresh.has(presented)) {
      this.refreshReuseAttempts++;
      return json(400, {
        error: 'invalid_grant',
        error_description: 'refresh token unknown or reused',
      });
    }
    const access = `at-${randomUUID()}`;
    this.access.set(access, { expiresAt: Date.now() + this.accessTtlSec * 1000 });
    let refresh: string | undefined;
    if (this.rotate) {
      this.validRefresh.delete(presented);
      refresh = `rt-${randomUUID()}`;
      this.validRefresh.set(refresh, { clientId: this.clientId });
    }
    return json(200, {
      access_token: access,
      token_type: 'Bearer',
      expires_in: this.accessTtlSec,
      ...(refresh && !this.omitRefreshToken ? { refresh_token: refresh } : {}),
    });
  }
}

// ─── Harness ─────────────────────────────────────────────────────────────────────────────────────

let world: FakeOAuthWorld;
let dir: string;
let callbackPort: number;
const clients: Client[] = [];
const children: Array<ReturnType<typeof spawn>> = [];

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const ID = 'fake';

function tokenFile(id = ID): string {
  return join(dir, `${id}.json`);
}

async function readGrant(id = ID): Promise<Record<string, any>> {
  return JSON.parse(await readFile(tokenFile(id), 'utf-8'));
}

/** Write a grant file as a successful authorization would have (optionally a legacy shape). */
async function seedGrant(
  opts: { discovery?: boolean; resource?: boolean; id?: string } = {}
): Promise<{ access: string; refresh: string }> {
  const grant = world.issueGrant();
  const issuer = world.issuer;
  const data: Record<string, unknown> = {
    clientInfo: {
      client_id: world.clientId,
      redirect_uris: [`http://127.0.0.1:${callbackPort}/oauth/callback`],
      issuer,
    },
    tokens: {
      access_token: grant.access,
      token_type: 'Bearer',
      refresh_token: grant.refresh,
      expires_in: world.accessTtlSec,
      issuer,
    },
    obtainedAt: Date.now(),
    issuer,
  };
  if (opts.discovery !== false) data.discovery = world.discoveryState();
  if (opts.resource !== false) data.resource = world.mcpUrl;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(tokenFile(opts.id), JSON.stringify(data, null, 2), { mode: 0o600 });
  return grant;
}

/** The invariant every case ends with: the file holds a grant the AS would honour right now. */
async function expectUsableGrant(id = ID): Promise<void> {
  const data = await readGrant(id);
  expect(data.clientInfo?.client_id).toBe(world.clientId);
  expect(typeof data.tokens?.refresh_token).toBe('string');
  expect(world.validRefresh.has(data.tokens.refresh_token)).toBe(true);
}

function makeClient(storage: 'writer' | 'readonly' = 'writer'): Client {
  const client = new HttpMcpClient(
    ID,
    world.mcpUrl,
    undefined,
    true,
    callbackPort,
    undefined,
    undefined,
    undefined,
    undefined,
    10_000,
    { oauthStorage: storage, oauthStoreDir: dir }
  );
  clients.push(client);
  return client;
}

function provider(storage: 'writer' | 'readonly' = 'writer') {
  return new FileOAuthProvider(ID, callbackPort, undefined, undefined, undefined, {
    storage,
    storeDir: dir,
  });
}

function refreshRequests(): TokenRequestLog[] {
  return world.tokenRequests.filter((r) => r.grantType === 'refresh_token');
}

async function callEcho(client: Client): Promise<string> {
  const result = (await client.callTool('echo', {})) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  return `${result.isError ? 'error:' : ''}${result.content[0]?.text}`;
}

beforeEach(async () => {
  world = new FakeOAuthWorld();
  await world.start();
  dir = await mkdtemp(join(tmpdir(), 'airlock-oauth-lifecycle-'));
  callbackPort = await freePort();
  execFileMock.mockReset();
});

afterEach(async () => {
  setOAuthRequestTimeout();
  for (const client of clients.splice(0)) await client.stop().catch(() => {});
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await world.stop();
  await rm(dir, { recursive: true, force: true });
});

// ─── Cases ───────────────────────────────────────────────────────────────────────────────────────

describe('OAuth lifecycle — rotation and restarts', () => {
  it('rotates refresh tokens across many cycles without ever reusing one', async () => {
    await seedGrant();
    const client = makeClient();
    await client.connect();
    expect(await callEcho(client)).toMatch(/^ok:/);

    for (let i = 0; i < 25; i++) {
      await (client as unknown as Internals).proactiveRefresh();
      await expectUsableGrant();
    }
    expect(refreshRequests()).toHaveLength(25);
    expect(world.refreshReuseAttempts).toBe(0);
    expect(await callEcho(client)).toMatch(/^ok:/);
    expect(client.getOAuthHealth()).toMatchObject({ state: 'ok', consecutiveFailures: 0 });
    // History is bounded and private.
    const history = await readdir(join(dir, '.history', ID));
    expect(history.length).toBe(HISTORY_LIMIT);
    for (const file of history) {
      expect((await stat(join(dir, '.history', ID, file))).mode & 0o777).toBe(0o600);
    }
    expect((await stat(join(dir, '.history', ID))).mode & 0o777).toBe(0o700);
    await expectUsableGrant();
  });

  it('survives a gateway restart mid-lifetime and continues the rotation chain', async () => {
    await seedGrant();
    const first = makeClient();
    await first.connect();
    await (first as unknown as Internals).proactiveRefresh();
    await (first as unknown as Internals).proactiveRefresh();
    await first.stop();

    const second = makeClient(); // fresh provider instance, nothing in memory
    await second.connect();
    expect(await callEcho(second)).toMatch(/^ok:/);
    await (second as unknown as Internals).proactiveRefresh();
    expect(world.refreshReuseAttempts).toBe(0);
    expect(second.getOAuthHealth()?.state).toBe('ok');
    await expectUsableGrant();
  });

  it('takes over a writer lock left behind by a dead process (restarted gateway)', async () => {
    await seedGrant();
    const dead = spawn(process.execPath, ['-e', '']);
    const deadPid = dead.pid!;
    await new Promise((resolve) => dead.on('exit', resolve));
    await writeFile(
      join(dir, WRITER_LOCK_FILE),
      JSON.stringify({ pid: deadPid, hostname: hostname(), nonce: 'old', heartbeatAt: Date.now() })
    );

    const outcome = await refreshGrant(provider(), world.mcpUrl);
    expect(outcome.kind).toBe('refreshed');
    await expectUsableGrant();
  });

  it('keeps the refresh token when a refresh response omits it', async () => {
    await seedGrant();
    world.rotate = false;
    world.omitRefreshToken = true;
    const original = (await readGrant()).tokens.refresh_token as string;
    const client = makeClient();
    await client.connect();
    for (let i = 0; i < 5; i++) await (client as unknown as Internals).proactiveRefresh();

    const data = await readGrant();
    expect(data.tokens.refresh_token).toBe(original);
    expect(refreshRequests().every((r) => r.refreshToken === original)).toBe(true);
    expect(await callEcho(client)).toMatch(/^ok:/);
    await expectUsableGrant();
  });
});

describe('OAuth lifecycle — transient failures', () => {
  it('retries 5xx, resets, garbage bodies and timeouts with backoff and never touches the grant', async () => {
    setOAuthRequestTimeout(300);
    await seedGrant();
    const client = makeClient();
    await client.connect();
    const before = await readFile(tokenFile(), 'utf-8');

    world.failures = [500, 503, 'reset', 'garbage', 'hang'];
    const delays: number[] = [];
    for (let i = 1; i <= 5; i++) {
      const started = Date.now();
      await (client as unknown as Internals).proactiveRefresh();
      const health = client.getOAuthHealth()!;
      expect(health.state).toBe('refresh_failing');
      expect(health.consecutiveFailures).toBe(i);
      delays.push(Date.parse(health.nextRetryAt!) - started);
      expect(await readFile(tokenFile(), 'utf-8')).toBe(before);
    }
    // 1m, 2m, 4m, 8m, 16m (each measured from just before the attempt).
    expect(delays[0]).toBeGreaterThanOrEqual(60_000);
    expect(delays[0]).toBeLessThan(62_000);
    expect(delays[1]).toBeGreaterThanOrEqual(120_000);
    expect(delays[4]).toBeGreaterThanOrEqual(16 * 60_000);
    // The connection stayed up: the access token was still valid all along.
    expect(client.getConnectionStatus()).toMatchObject({
      status: 'up',
      oauth: { state: 'refresh_failing', consecutiveFailures: 5 },
    });

    await (client as unknown as Internals).proactiveRefresh();
    expect(client.getOAuthHealth()).toMatchObject({ state: 'ok', consecutiveFailures: 0 });
    expect(client.getConnectionStatus()).toEqual({ status: 'up' });
    await expectUsableGrant();
  });

  it('caps the retry backoff at 30 minutes and keeps retrying', async () => {
    await seedGrant();
    const client = makeClient();
    await client.connect();
    world.failures = Array.from({ length: 12 }, () => 503 as const);
    for (let i = 0; i < 12; i++) await (client as unknown as Internals).proactiveRefresh();
    const health = client.getOAuthHealth()!;
    expect(health.consecutiveFailures).toBe(12);
    const delay = Date.parse(health.nextRetryAt!) - Date.now();
    expect(delay).toBeLessThanOrEqual(30 * 60_000);
    expect(delay).toBeGreaterThan(29 * 60_000);
    await expectUsableGrant();
  });
});

describe('OAuth lifecycle — discovery outages', () => {
  it('refreshes with the known-good metadata and the authorization-time resource when PRM and AS metadata are down', async () => {
    await seedGrant();
    world.prmDown = true;
    world.asMetadataDown = true;
    const outcome = await refreshGrant(provider(), world.mcpUrl);
    expect(outcome.kind).toBe('refreshed');
    const last = refreshRequests().at(-1)!;
    expect(last.resource).toBe(world.mcpUrl);
    expect(last.endpoint).toBe('/');
    await expectUsableGrant();
  });

  it('learns discovery + resource for a legacy grant, then keeps sending the resource through a PRM outage', async () => {
    await seedGrant({ discovery: false, resource: false });
    expect(await refreshGrant(provider(), world.mcpUrl)).toMatchObject({ kind: 'refreshed' });
    const learned = await readGrant();
    expect(learned.resource).toBe(world.mcpUrl);
    expect(learned.discovery?.resourceMetadata?.resource).toBe(world.mcpUrl);

    // Railway, 11-10 → 11-13: PRM unavailable. The SDK would fall back to the server origin as AS
    // and drop `resource`; Airlock uses what it knows instead.
    world.prmDown = true;
    for (let i = 0; i < 3; i++) {
      expect(await refreshGrant(provider(), world.mcpUrl)).toMatchObject({ kind: 'refreshed' });
    }
    expect(refreshRequests().every((r) => r.resource === world.mcpUrl)).toBe(true);
    await expectUsableGrant();
  });

  it('reports (not hides) a discovery outage when nothing known-good is stored, and keeps the grant', async () => {
    await seedGrant({ discovery: false, resource: false });
    world.prmDown = true;
    world.asMetadataDown = true;
    const before = await readFile(tokenFile(), 'utf-8');
    const outcome = await refreshGrant(provider(), world.mcpUrl);
    expect(outcome.kind).toBe('failed');
    expect(await readFile(tokenFile(), 'utf-8')).toBe(before);
    await expectUsableGrant();
  });
});

describe('OAuth lifecycle — issuer change', () => {
  it('refreshes against the new issuer with the stored refresh token and re-stamps the grant', async () => {
    await seedGrant();
    const oldIssuer = world.issuer;
    const client = makeClient();
    await client.connect();

    world.issuerPath = '/_clerk'; // https://clerk.x → https://x/_clerk
    await (client as unknown as Internals).proactiveRefresh();

    const data = await readGrant();
    expect(data.issuer).toBe(world.issuer);
    expect(data.tokens.issuer).toBe(world.issuer);
    expect(data.clientInfo.issuer).toBe(world.issuer);
    expect(data.discovery.authorizationServerMetadata.issuer).toBe(world.issuer);
    expect(refreshRequests().at(-1)!.endpoint).toBe('/_clerk');
    expect(client.getOAuthHealth()).toMatchObject({
      state: 'ok',
      issuerChanged: { from: oldIssuer, to: world.issuer },
    });
    await expectUsableGrant();
  });

  it('falls back to the previous issuer when the new one rejects the grant', async () => {
    await seedGrant();
    const oldIssuer = world.issuer;
    world.issuerPath = '/_clerk';
    world.rejectingIssuers.add(world.issuer);
    const outcome = await refreshGrant(provider(), world.mcpUrl);
    expect(outcome).toMatchObject({ kind: 'refreshed', issuer: oldIssuer });
    expect((await readGrant()).issuer).toBe(oldIssuer);
    await expectUsableGrant();
  });

  it('keeps the grant intact when both issuers reject it, and recovers later', async () => {
    await seedGrant();
    const oldIssuer = world.issuer;
    world.issuerPath = '/_clerk';
    world.rejectingIssuers.add(oldIssuer).add(world.issuer);
    const before = await readFile(tokenFile(), 'utf-8');
    const outcome = await refreshGrant(provider(), world.mcpUrl);
    expect(outcome).toMatchObject({
      kind: 'rejected',
      code: 'invalid_grant',
      issuerChange: { from: oldIssuer, to: world.issuer },
    });
    expect(await readFile(tokenFile(), 'utf-8')).toBe(before);

    world.rejectingIssuers.clear();
    expect(await refreshGrant(provider(), world.mcpUrl)).toMatchObject({ kind: 'refreshed' });
    await expectUsableGrant();
  });

  it('even the SDK auth() path cannot drop a grant on issuer mismatch (it only stages a new authorization)', async () => {
    await seedGrant();
    world.issuerPath = '/_clerk';
    const p = provider();
    const before = await readGrant();
    // The SDK discards tokens whose issuer stamp mismatches and falls through to a browser flow.
    const result = await auth(p, { serverUrl: world.mcpUrl });
    expect(result).toBe('REDIRECT');
    const after = await readGrant();
    expect(after.tokens).toEqual(before.tokens);
    expect(after.clientInfo.client_id).toBe(before.clientInfo.client_id);
    expect(after.pending?.codeVerifier).toBeTruthy();
    // The SDK registered a new client at the new issuer: staged, not swapped in.
    expect(after.pending?.clientInfo?.client_id).toMatch(/^registered-/);
    await expectUsableGrant();
  });
});

describe('OAuth lifecycle — issuer rejections', () => {
  it('invalid_grant: keeps the grant, backs off exponentially, recovers when the AS recovers', async () => {
    await seedGrant();
    const client = makeClient();
    await client.connect();
    const before = await readFile(tokenFile(), 'utf-8');

    world.rejectingIssuers.add(world.issuer);
    for (let i = 1; i <= 3; i++) {
      const started = Date.now();
      await (client as unknown as Internals).proactiveRefresh();
      const health = client.getOAuthHealth()!;
      expect(health).toMatchObject({ state: 'grant_rejected', consecutiveFailures: i });
      expect(health.lastError).toContain('invalid_grant');
      expect(Date.parse(health.nextRetryAt!) - started).toBeGreaterThanOrEqual(
        60_000 * 2 ** (i - 1)
      );
      expect(await readFile(tokenFile(), 'utf-8')).toBe(before);
    }
    expect(execFileMock).not.toHaveBeenCalled(); // no browser while the access token still works
    expect(client.isReady()).toBe(true);

    world.rejectingIssuers.clear();
    await (client as unknown as Internals).proactiveRefresh();
    expect(client.getOAuthHealth()).toMatchObject({ state: 'ok', consecutiveFailures: 0 });
    await expectUsableGrant();
  });

  it('SDK invalidateCredentials() never deletes the grant', async () => {
    await seedGrant();
    const p = provider();
    for (const scope of ['tokens', 'client', 'all', 'verifier', 'discovery'] as const) {
      await p.invalidateCredentials(scope);
    }
    await expectUsableGrant();
  });

  it('a rejected grant with a dead access token offers browser auth without clobbering, and an operator authorization replaces it', async () => {
    const original = await seedGrant();
    world.rejectingIssuers.add(world.issuer);
    world.revokeAccessTokens();
    const client = makeClient();
    await client.connect();

    // auth_required with a precise reason; browser authorization prepared as *pending*.
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalled(), { timeout: 5000 });
    const status = client.getConnectionStatus();
    expect(status.status).toBe('auth_required');
    expect(status.reason).toContain('rejected');
    expect(status.oauth).toMatchObject({ state: 'grant_rejected', authorizationPending: true });
    const staged = await readGrant();
    expect(staged.tokens.refresh_token).toBe(original.refresh);
    expect(staged.pending?.codeVerifier).toBeTruthy();

    // The operator completes the browser flow.
    const authorizeUrl = new URL((execFileMock.mock.calls[0] as [string, string[]])[1][0]);
    const code = `code-${randomUUID()}`;
    world.codes.set(code, {
      clientId: world.clientId,
      challenge: authorizeUrl.searchParams.get('code_challenge')!,
      redirectUri: authorizeUrl.searchParams.get('redirect_uri')!,
    });
    expect(authorizeUrl.searchParams.get('resource')).toBe(world.mcpUrl);
    const state = authorizeUrl.searchParams.get('state');
    const callback = new URL(`http://127.0.0.1:${callbackPort}/oauth/callback`);
    callback.searchParams.set('code', code);
    if (state) callback.searchParams.set('state', state);
    await vi.waitFor(async () => expect((await fetch(callback)).status).toBe(200), {
      timeout: 5000,
    });

    await vi.waitFor(() => expect(client.isReady()).toBe(true), { timeout: 5000 });
    expect(await callEcho(client)).toMatch(/^ok:/);
    const replaced = await readGrant();
    expect(replaced.tokens.refresh_token).not.toBe(original.refresh);
    expect(replaced.pending).toBeUndefined();
    expect(replaced.resource).toBe(world.mcpUrl);
    expect(client.getOAuthHealth()?.state).toBe('ok');

    // The replaced grant is recoverable from history.
    const { data } = (await oauthCommand(['history', ID, '--dir', dir, '--json'])) as {
      data: { history: Array<{ reason: string }> };
    };
    expect(data.history.some((h) => h.reason === 'authorization')).toBe(true);
    world.rejectingIssuers.clear();
    await expectUsableGrant();
  });
});

describe('OAuth lifecycle — second process', () => {
  it('a read-only CLI client never refreshes, writes, or wipes the grant', async () => {
    await seedGrant();
    world.revokeAccessTokens(); // the CLI's access token is dead → 401
    const before = await readFile(tokenFile(), 'utf-8');
    const cli = makeClient('readonly');
    await cli.connect();
    await new Promise((r) => setTimeout(r, 100));

    expect(cli.isReady()).toBe(false);
    expect(cli.getConnectionStatus()).toMatchObject({
      status: 'auth_required',
      oauth: { state: 'read_only', storage: 'readonly' },
    });
    expect(world.tokenRequests).toHaveLength(0);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(await readFile(tokenFile(), 'utf-8')).toBe(before);
    // Even an explicit SDK-driven invalidation from that process is a no-op on disk.
    await provider('readonly').invalidateCredentials('all');
    expect(await readFile(tokenFile(), 'utf-8')).toBe(before);
    await expectUsableGrant();
  });

  it('a writer-capable process cannot refresh while another live process holds the lock', async () => {
    await seedGrant();
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    children.push(holder);
    await writeFile(
      join(dir, WRITER_LOCK_FILE),
      JSON.stringify({
        pid: holder.pid,
        hostname: hostname(),
        nonce: 'gateway',
        acquiredAt: Date.now(),
        heartbeatAt: Date.now(),
      })
    );
    const before = await readFile(tokenFile(), 'utf-8');

    const outcome = await refreshGrant(provider(), world.mcpUrl);
    expect(outcome.kind).toBe('read_only');
    expect(world.tokenRequests).toHaveLength(0);
    expect(await readFile(tokenFile(), 'utf-8')).toBe(before);

    holder.kill('SIGKILL');
    await new Promise((resolve) => holder.on('exit', resolve));
    expect(await refreshGrant(provider(), world.mcpUrl)).toMatchObject({ kind: 'refreshed' });
    await expectUsableGrant();
  });
});

describe('OAuth lifecycle — expiry signalling and concurrency', () => {
  it('app-level expiry (no 401): proactive refresh keeps the provider working', async () => {
    world.expiryStyle = 'app';
    await seedGrant();
    const client = makeClient();
    await client.connect();
    expect(await callEcho(client)).toMatch(/^ok:/);

    world.expireAccessTokens();
    // Without a refresh the server answers 200 + error result; nothing would ever trigger a 401.
    expect(await callEcho(client)).toBe('error:access token expired');
    expect(world.unauthorizedResponses).toBe(0);

    await (client as unknown as Internals).proactiveRefresh();
    expect(await callEcho(client)).toMatch(/^ok:/);
    expect(world.unauthorizedResponses).toBe(0);
    await expectUsableGrant();
  });

  it('concurrent proactive + reactive refresh spend the rotating refresh token once', async () => {
    await seedGrant();
    const client = makeClient();
    await client.connect();
    world.tokenDelayMs = 200;
    world.revokeAccessTokens(); // next tool call → 401 → reactive refresh

    const [, echoed] = await Promise.all([
      (client as unknown as Internals).proactiveRefresh(),
      callEcho(client),
    ]);
    expect(echoed).toMatch(/^ok:/);
    expect(refreshRequests()).toHaveLength(1);
    expect(world.refreshReuseAttempts).toBe(0);
    await expectUsableGrant();
  });

  it('parallel refreshGrant() calls share one token request', async () => {
    await seedGrant();
    world.tokenDelayMs = 100;
    const p = provider();
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => refreshGrant(p, world.mcpUrl))
    );
    expect(new Set(outcomes).size).toBe(1);
    expect(refreshRequests()).toHaveLength(1);
    await expectUsableGrant();
  });
});

describe('OAuth lifecycle — backups and restore', () => {
  it('lists and restores backups without printing secrets', async () => {
    const original = await seedGrant();
    for (let i = 0; i < 3; i++) await refreshGrant(provider(), world.mcpUrl);
    const current = (await readGrant()).tokens.refresh_token as string;

    const history = await oauthCommand(['history', ID, '--dir', dir]);
    expect(history.exitCode).toBe(0);
    const status = await oauthCommand(['status', '--dir', dir, '--json']);
    for (const output of [
      history.text,
      JSON.stringify(history.data),
      JSON.stringify(status.data),
    ]) {
      expect(output).not.toContain(original.refresh);
      expect(output).not.toContain(original.access);
      expect(output).not.toContain(current);
    }

    const entries = (
      (await oauthCommand(['history', ID, '--dir', dir, '--json'])).data as {
        history: Array<{ version: string }>;
      }
    ).history;
    expect(entries).toHaveLength(3);
    const oldest = entries.at(-1)!.version;
    const restored = await oauthCommand(['restore', ID, oldest, '--dir', dir]);
    expect(restored.exitCode).toBe(0);
    expect(restored.text).not.toContain(original.refresh);
    expect((await readGrant()).tokens.refresh_token).toBe(original.refresh);

    // The grant replaced by the restore is itself backed up (a restore can be undone).
    const after = (
      (await oauthCommand(['history', ID, '--dir', dir, '--json'])).data as {
        history: Array<{ reason: string }>;
      }
    ).history;
    expect(after[0].reason).toBe('restore');
    // That restored grant was rotated away by the AS; put the current one back to end usable.
    const undo = after[0] as unknown as { version: string };
    await oauthCommand(['restore', ID, undo.version, '--dir', dir]);
    expect((await readGrant()).tokens.refresh_token).toBe(current);
    await expectUsableGrant();
  });

  it('never overwrites an unparseable grant file without backing it up first', async () => {
    await seedGrant();
    await writeFile(tokenFile(), '{ not json', { mode: 0o600 });
    const p = provider();
    await p.beginAuthorization();
    const backups = await readdir(join(dir, '.history', ID));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(dir, '.history', ID, backups[0]), 'utf-8')).toBe('{ not json');
    await chmod(tokenFile(), 0o600);
  });
});
