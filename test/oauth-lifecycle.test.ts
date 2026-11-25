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
 *   - writer-lock takeover races between real processes, and a frozen owner resuming mid-exchange
 *   - a stale read racing a rotation whose disk write failed
 *   - a refresh racing a new browser authorization (different client registrations)
 *   - an exchange whose answer is lost after the issuer rotated (ambiguous), and a crash between
 *     exchange and commit
 *   - issuer migration with a healthy old endpoint and an unavailable new one
 *   - operator restore while a gateway owns the store
 *   - idle grants whose refresh-token inactivity window is shorter than the access-token lifetime
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
const { HISTORY_LIMIT, restoreGrant } = await import('../src/pool/oauth-store.js');
const {
  WRITER_LOCK_PREFIX,
  lockNamespace,
  releaseAllWriterLocks,
  setWriterLockTimings,
  writerLockFor,
} = await import('../src/pool/oauth-lock.js');

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

/** `rotate-reset`: the issuer rotates the presented token, then the connection drops. */
type InjectedFailure = 500 | 503 | 'hang' | 'reset' | 'garbage' | 'rotate-reset';

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
  /** Issuers whose token endpoint no longer exists (404). */
  goneIssuers = new Set<string>();
  /** Issuers whose token endpoint answers 503 to everything. */
  unavailableIssuers = new Set<string>();
  /** Accept an already-rotated refresh token again within this window (0 = strict single use). */
  reuseGraceMs = 0;
  readonly consumedAt = new Map<string, number>();
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
    if (failure === 'rotate-reset') {
      const presented = form.get('refresh_token') ?? '';
      if (this.validRefresh.delete(presented)) {
        this.consumedAt.set(presented, Date.now());
        this.validRefresh.set(`rt-${randomUUID()}`, { clientId: this.clientId }); // never delivered
      }
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
    if (this.goneIssuers.has(this.issuerFor(issuerPath))) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<html>not found</html>');
      return;
    }
    if (this.unavailableIssuers.has(this.issuerFor(issuerPath))) {
      return json(503, { error: 'temporarily_unavailable' });
    }
    if (this.rejectingIssuers.has(this.issuerFor(issuerPath))) {
      return json(400, { error: 'invalid_grant', error_description: 'refresh token rejected' });
    }
    const presented = form.get('refresh_token') ?? '';
    const consumed = this.consumedAt.get(presented);
    const inGrace = consumed !== undefined && Date.now() - consumed <= this.reuseGraceMs;
    if (!this.validRefresh.has(presented) && !inGrace) {
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
      if (this.validRefresh.delete(presented)) this.consumedAt.set(presented, Date.now());
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

/** Write a lock generation file as another process would have. */
async function writeForeignLock(
  record: { pid: number; hostname?: string; ns?: string; heartbeatAt?: number; released?: boolean },
  gen = 1
): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(dir, `${WRITER_LOCK_PREFIX}${String(gen).padStart(12, '0')}`),
    JSON.stringify({
      hostname: hostname(),
      nonce: `foreign-${randomUUID()}`,
      acquiredAt: Date.now(),
      heartbeatAt: Date.now(),
      ...record,
    })
  );
}

/** The grant-relevant part of the file (the file also carries exchange markers). */
async function grantCore(id = ID): Promise<{ clientInfo: unknown; tokens: unknown }> {
  const data = await readGrant(id);
  return { clientInfo: data.clientInfo, tokens: data.tokens };
}

async function historyReasons(): Promise<string[]> {
  const files = await readdir(join(dir, '.history', ID)).catch(() => [] as string[]);
  return files.map((f) =>
    f
      .replace(/\.json$/, '')
      .split('-')
      .slice(1)
      .join('-')
  );
}

const fixture = join(import.meta.dirname, 'fixtures', 'oauth-lock-child.ts');

/** Spawn a TypeScript entry point in a separate node process; collect its JSON lines. */
function spawnTs(args: string[]): {
  child: ReturnType<typeof spawn>;
  events: Array<Record<string, any>>;
  stdout: () => string;
  exited: Promise<number | null>;
} {
  const child = spawn(process.execPath, ['--import', 'tsx', ...args], {
    cwd: join(import.meta.dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const events: Array<Record<string, any>> = [];
  let buffer = '';
  let all = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    all += chunk.toString();
    buffer += chunk.toString();
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      try {
        events.push(JSON.parse(line));
      } catch {
        events.push({ event: 'text', line });
      }
    }
  });
  child.stderr!.on('data', () => {});
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, events, stdout: () => all, exited };
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
  vi.restoreAllMocks();
  await releaseAllWriterLocks();
  setWriterLockTimings();
  for (const client of clients.splice(0)) await client.stop().catch(() => {});
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await world.stop();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
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
    // History is bounded and private (backups are written after each commit, asynchronously).
    await vi.waitFor(async () =>
      expect((await readdir(join(dir, '.history', ID))).length).toBe(HISTORY_LIMIT)
    );
    const history = await readdir(join(dir, '.history', ID));
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
    // Same host, boot and pid namespace: a dead pid proves the holder is gone (no waiting).
    await writeForeignLock({ pid: deadPid, ns: lockNamespace() });

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
    const before = await grantCore();

    // The issuer answered (without tokens): definitive failures.
    world.failures = [500, 503, 'garbage'];
    // The answer was lost after sending: ambiguous (the fake did not rotate here, a real issuer
    // might have) — classified as such, retried at the same endpoint, and reported.
    world.failures.push('reset', 'hang');
    const delays: number[] = [];
    const states: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const started = Date.now();
      await (client as unknown as Internals).proactiveRefresh();
      const health = client.getOAuthHealth()!;
      states.push(health.state);
      expect(health.consecutiveFailures).toBe(i);
      delays.push(Date.parse(health.nextRetryAt!) - started);
      expect(await grantCore()).toEqual(before);
    }
    expect(states).toEqual([
      'refresh_failing',
      'refresh_failing',
      'refresh_failing',
      'refresh_ambiguous',
      'refresh_ambiguous',
    ]);
    // 1m, 2m, 4m; the first ambiguous failure retries after 5 s (issuer reuse-grace windows),
    // then the normal backoff continues (16m).
    expect(delays[0]).toBeGreaterThanOrEqual(60_000);
    expect(delays[0]).toBeLessThan(62_000);
    expect(delays[1]).toBeGreaterThanOrEqual(120_000);
    expect(delays[3]).toBeGreaterThanOrEqual(5_000);
    expect(delays[3]).toBeLessThan(7_000);
    expect(delays[4]).toBeGreaterThanOrEqual(16 * 60_000);
    // The ambiguity is persisted in the grant and visible in status.
    expect((await readGrant()).exchange).toMatchObject({ state: 'ambiguous' });
    const status = await oauthCommand(['status', '--dir', dir]);
    expect(status.text).toContain('REFRESH AMBIGUOUS');
    // The connection stayed up: the access token was still valid all along.
    expect(client.getConnectionStatus()).toMatchObject({
      status: 'up',
      oauth: {
        state: 'refresh_ambiguous',
        consecutiveFailures: 5,
        exchange: { state: 'ambiguous' },
      },
    });

    await (client as unknown as Internals).proactiveRefresh();
    expect(client.getOAuthHealth()).toMatchObject({ state: 'ok', consecutiveFailures: 0 });
    expect(client.getConnectionStatus()).toEqual({ status: 'up' });
    expect((await readGrant()).exchange).toBeUndefined();
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
  it('migrates to the new issuer with the stored refresh token once the old endpoint is gone, and re-stamps the grant', async () => {
    await seedGrant();
    const oldIssuer = world.issuer;
    const client = makeClient();
    await client.connect();

    world.issuerPath = '/_clerk'; // https://clerk.x → https://x/_clerk
    world.goneIssuers.add(oldIssuer); // the old token endpoint was retired
    await (client as unknown as Internals).proactiveRefresh();

    const data = await readGrant();
    expect(data.issuer).toBe(world.issuer);
    expect(data.tokens.issuer).toBe(world.issuer);
    expect(data.clientInfo.issuer).toBe(world.issuer);
    expect(data.discovery.authorizationServerMetadata.issuer).toBe(world.issuer);
    expect(refreshRequests().at(-1)!.endpoint).toBe('/_clerk');
    expect(client.getOAuthHealth()).toMatchObject({
      state: 'ok',
      issuerChanged: { from: oldIssuer, to: world.issuer, migrated: true },
    });
    await expectUsableGrant();
  });

  it('keeps refreshing at the healthy previous issuer while the newly advertised one is down', async () => {
    await seedGrant();
    const oldIssuer = world.issuer;
    const client = makeClient();
    await client.connect();
    world.issuerPath = '/_clerk';
    world.unavailableIssuers.add(world.issuer); // new endpoint persistently unavailable

    for (let i = 0; i < 3; i++) {
      await (client as unknown as Internals).proactiveRefresh();
      expect(client.getOAuthHealth()).toMatchObject({
        state: 'ok',
        issuerChanged: { from: oldIssuer, to: world.issuer, migrated: false },
      });
    }
    expect(refreshRequests().map((r) => r.endpoint)).toEqual(['/', '/', '/']);
    expect((await readGrant()).issuer).toBe(oldIssuer);
    await expectUsableGrant();
  });

  it('does not fan out to the new issuer when the known-good one has a transient failure', async () => {
    await seedGrant();
    world.issuerPath = '/_clerk';
    world.failures = [503];
    const outcome = await refreshGrant(provider(), world.mcpUrl);
    expect(outcome).toMatchObject({ kind: 'failed' });
    expect(refreshRequests().map((r) => r.endpoint)).toEqual(['/']);
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
    // Definitive answers leave no marker: the file is byte-identical.
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
    await writeForeignLock({ pid: holder.pid!, ns: lockNamespace() });
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
    for (let i = 0; i < 3; i++) {
      const p = provider();
      await refreshGrant(p, world.mcpUrl);
      await p.store.flushHistory();
    }
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
    await p.store.flushHistory();
    const backups = await readdir(join(dir, '.history', ID));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(dir, '.history', ID, backups[0]), 'utf-8')).toBe('{ not json');
    await chmod(tokenFile(), 0o600);
  });
});

// ─── Review hardening: each case below fails against the previous implementation ────────────────

describe('OAuth lifecycle — writer lock takeover (separate processes)', () => {
  it('exactly one of several processes wins a simultaneous takeover of a stale lock', async () => {
    // A holder on another host that stopped heartbeating: pids cannot be checked, only observed.
    await writeForeignLock({ pid: 1, hostname: 'other-host', ns: 'other-host|boot|pidns' });
    const racers = Array.from({ length: 5 }, () => spawnTs([fixture, 'race', dir, '300']));
    await vi.waitFor(
      () => expect(racers.every((r) => r.events.some((e) => e.event === 'observed'))).toBe(true),
      { timeout: 20_000, interval: 50 }
    );
    // Nobody may take a lock it has not watched go stale.
    expect(
      racers.every((r) => r.events.find((e) => e.event === 'observed')!.acquired === false)
    ).toBe(true);
    await new Promise((r) => setTimeout(r, 450));
    await writeFile(join(dir, 'go'), '');
    await Promise.all(racers.map((r) => r.exited));

    const raced = racers.map((r) => r.events.find((e) => e.event === 'raced')!.acquired as boolean);
    const verified = racers.map(
      (r) => r.events.find((e) => e.event === 'verified')!.owner as boolean
    );
    expect(raced.filter(Boolean)).toHaveLength(1);
    expect(verified).toEqual(raced);
    const files = (await readdir(dir)).filter(
      (f) => f.startsWith(WRITER_LOCK_PREFIX) && !f.endsWith('.tmp')
    );
    expect(files).toEqual([`${WRITER_LOCK_PREFIX}${String(2).padStart(12, '0')}`]);
  }, 30_000);

  it('an owner frozen mid-exchange fails its commit-time fencing check after a takeover', async () => {
    setWriterLockTimings({ staleMs: 400, takeoverGraceMs: 300, heartbeatMs: 60_000 });
    const owner = spawnTs([fixture, 'paused', dir]);
    await vi.waitFor(
      () => expect(owner.events[0]).toMatchObject({ event: 'acquired', acquired: true }),
      {
        timeout: 20_000,
        interval: 50,
      }
    );
    await writeFile(join(dir, 'go'), '');
    await vi.waitFor(() => expect(owner.events[1]).toMatchObject({ event: 'send', owner: true }), {
      timeout: 5_000,
      interval: 20,
    });
    owner.child.kill('SIGSTOP'); // frozen with its token request "in flight"

    const lock = writerLockFor(dir);
    expect(await lock.ensure()).toBe(false); // first observation: still live
    await vi.waitFor(async () => expect(await lock.ensure()).toBe(true), {
      timeout: 5_000,
      interval: 100,
    });

    owner.child.kill('SIGCONT');
    await writeFile(join(dir, 'commit'), '');
    await owner.exited;
    expect(owner.events[2]).toMatchObject({ event: 'commit', owner: false });
    expect(await lock.verify()).toBe(true);
  }, 30_000);

  it('a refresh whose process lost the lock mid-exchange parks the successor; the new owner adopts it', async () => {
    await seedGrant();
    const p = provider();
    world.tokenDelayMs = 300;
    const pending = refreshGrant(p, world.mcpUrl);
    await vi.waitFor(() => expect(refreshRequests()).toHaveLength(1), { interval: 10 });
    // Another process takes the lock over while the token request is in flight.
    await writeForeignLock({ pid: 1, hostname: 'other-host', ns: 'x' }, 99);
    const outcome = await pending;
    expect(outcome).toMatchObject({ kind: 'refreshed', persistence: 'handed_off' });
    expect((await readdir(join(dir, '.successors', ID))).length).toBe(1);
    // The grant file was not written by the process that lost the lock.
    expect(world.validRefresh.has((await readGrant()).tokens.refresh_token)).toBe(false);

    // The other process releases; this one becomes the owner again and adopts the successor.
    await writeForeignLock({ pid: 1, hostname: 'other-host', ns: 'x', released: true }, 99);
    world.tokenDelayMs = 0;
    await expectUsableGrantAfter(() => refreshGrant(provider(), world.mcpUrl));
    expect(await readdir(join(dir, '.successors', ID))).toEqual([]);
    expect(world.refreshReuseAttempts).toBe(0);
  });
});

async function expectUsableGrantAfter(fn: () => Promise<unknown>): Promise<void> {
  const outcome = await fn();
  expect(outcome).toMatchObject({ kind: 'refreshed', persistence: 'persisted' });
  await expectUsableGrant();
}

describe('OAuth lifecycle — in-memory state vs disk', () => {
  it('a read started before a rotation cannot resurrect the spent token after a failed write', async () => {
    await seedGrant();
    const p = provider();
    await p.tokens();
    const store = p.store;
    const realRead = store.read.bind(store);
    const realWrite = store.write.bind(store);
    let releaseRead!: () => void;
    const readGate = new Promise<void>((r) => (releaseRead = r));
    let delayed = true;
    vi.spyOn(store, 'read').mockImplementation(async () => {
      const result = await realRead(); // reads R1 now…
      if (delayed) {
        delayed = false;
        await readGate; // …and returns it only after the rotation
      }
      return result;
    });
    let failCommit = true;
    vi.spyOn(store, 'write').mockImplementation(async (data, reason, opts) => {
      if (reason === 'refresh' && failCommit) {
        failCommit = false;
        throw new Error('ENOSPC: injected');
      }
      return realWrite(data, reason, opts);
    });

    const staleRead = p.tokens();
    const outcome = await refreshGrant(p, world.mcpUrl);
    expect(outcome).toMatchObject({ kind: 'refreshed', persistence: 'pending' });
    expect(p.persistencePending).toBe(true);
    releaseRead();
    await staleRead;
    expect(await p.retryPersistenceNow()).toBe(true);
    expect(p.persistencePending).toBe(false);

    // "Restart": a fresh instance only has the file.
    await provider().tokens();
    await expectUsableGrant();
    expect(await refreshGrant(provider(), world.mcpUrl)).toMatchObject({ kind: 'refreshed' });
    expect(world.refreshReuseAttempts).toBe(0);
  });

  it('reports persistence_pending, and spends no refresh token while the store is unwritable', async () => {
    await seedGrant();
    const client = makeClient();
    await client.connect();
    const p = (client as unknown as { oauthProvider: InstanceType<typeof FileOAuthProvider> })
      .oauthProvider;
    const realWrite = p.store.write.bind(p.store);
    let mode: 'commit-fails' | 'all-fail' | 'ok' = 'commit-fails';
    vi.spyOn(p.store, 'write').mockImplementation(async (data, reason, opts) => {
      if (mode === 'all-fail' || (mode === 'commit-fails' && reason === 'refresh')) {
        throw new Error('EIO: injected');
      }
      return realWrite(data, reason, opts);
    });

    await (client as unknown as Internals).proactiveRefresh();
    expect(client.getOAuthHealth()).toMatchObject({
      state: 'persistence_pending',
      persistencePending: true,
    });
    expect(client.getConnectionStatus().oauth?.state).toBe('persistence_pending');
    expect(await callEcho(client)).toMatch(/^ok:/); // the in-memory successor works

    mode = 'all-fail';
    const spent = refreshRequests().length;
    await (client as unknown as Internals).proactiveRefresh();
    expect(refreshRequests()).toHaveLength(spent); // not spent: its successor could not be stored
    expect(client.getOAuthHealth()?.lastError).toContain('not spent');

    mode = 'ok';
    expect(await p.retryPersistenceNow()).toBe(true);
    expect(client.getOAuthHealth()?.persistencePending).toBe(false);
    await expectUsableGrant();
  });

  it('writes the new grant before history, and a failing history never blocks the commit', async () => {
    await seedGrant();
    await mkdir(join(dir, '.history'), { recursive: true });
    await writeFile(join(dir, '.history', ID), 'not a directory'); // every backup fails
    const p = provider();
    expect(await refreshGrant(p, world.mcpUrl)).toMatchObject({
      kind: 'refreshed',
      persistence: 'persisted',
    });
    await p.store.flushHistory();
    await expectUsableGrant();
  });

  it('a crash between exchange and commit is visible after restart, and recovers with a reuse-tolerant issuer', async () => {
    await seedGrant();
    world.reuseGraceMs = 60_000;
    const crashed = provider();
    const realWrite = crashed.store.write.bind(crashed.store);
    vi.spyOn(crashed.store, 'write').mockImplementation(async (data, reason, opts) => {
      if (reason === 'refresh') throw new Error('process killed (simulated)');
      return realWrite(data, reason, opts);
    });
    await refreshGrant(crashed, world.mcpUrl); // the AS rotated; the successor never reached disk
    expect((await readGrant()).exchange).toMatchObject({ state: 'in_flight' });

    const status = await oauthCommand(['status', '--dir', dir, '--json']);
    expect(
      (status.data as { grants: Record<string, { exchange?: { state: string } }> }).grants[ID]
        .exchange?.state
    ).toBe('interrupted');

    const restarted = makeClient();
    await restarted.connect();
    expect(restarted.getOAuthHealth()).toMatchObject({
      state: 'refresh_ambiguous',
      exchange: { state: 'interrupted' },
    });
    await (restarted as unknown as Internals).proactiveRefresh();
    expect(restarted.getOAuthHealth()).toMatchObject({ state: 'ok' });
    expect((await readGrant()).exchange).toBeUndefined();
    await expectUsableGrant();
  });
});

describe('OAuth lifecycle — ambiguous exchanges', () => {
  it('answer lost after the issuer rotated: pinned retries, no fan-out, honest status (strict issuer)', async () => {
    await seedGrant();
    const client = makeClient();
    await client.connect();
    world.issuerPath = '/_clerk'; // a new issuer is advertised as well
    world.goneIssuers.add(world.issuerFor('')); // …and the old endpoint looks gone after the loss
    world.failures = ['rotate-reset'];

    await (client as unknown as Internals).proactiveRefresh();
    expect(client.getOAuthHealth()).toMatchObject({
      state: 'refresh_ambiguous',
      exchange: { state: 'ambiguous' },
    });
    const marker = (await readGrant()).exchange;
    expect(marker).toMatchObject({
      state: 'ambiguous',
      tokenEndpoint: `${world.issuerFor('')}/token`,
    });

    world.goneIssuers.clear();
    await (client as unknown as Internals).proactiveRefresh();
    // Only the same endpoint was tried, with the same (only) token.
    expect(refreshRequests().map((r) => r.endpoint)).toEqual(['/', '/']);
    expect(new Set(refreshRequests().map((r) => r.refreshToken)).size).toBe(1);
    const health = client.getOAuthHealth()!;
    expect(health.state).toBe('grant_rejected');
    expect(health.lastError).toContain('answer was lost');
    expect(health.exchange?.state).toBe('ambiguous');
    // The stored grant is kept (a browser authorization is the way out).
    expect((await readGrant()).tokens.refresh_token).toBe(refreshRequests()[0].refreshToken);
  });

  it('answer lost after the issuer rotated: recovers through the issuer reuse-grace window', async () => {
    await seedGrant();
    world.reuseGraceMs = 30_000;
    const client = makeClient();
    await client.connect();
    world.failures = ['rotate-reset'];
    await (client as unknown as Internals).proactiveRefresh();
    expect(client.getOAuthHealth()?.state).toBe('refresh_ambiguous');
    // The first retry after an ambiguous exchange is quick (inside common grace windows).
    expect(Date.parse(client.getOAuthHealth()!.nextRetryAt!) - Date.now()).toBeLessThan(6_000);
    await (client as unknown as Internals).proactiveRefresh();
    expect(client.getOAuthHealth()).toMatchObject({ state: 'ok' });
    expect(client.getOAuthHealth()?.exchange).toBeUndefined();
    await expectUsableGrant();
  });

  it('a connection refused before sending is not ambiguous and may try the next endpoint', async () => {
    await seedGrant();
    const data = await readGrant();
    const dead = await freePort();
    data.discovery.authorizationServerMetadata.token_endpoint = `http://127.0.0.1:${dead}/token`;
    await writeFile(tokenFile(), JSON.stringify(data));
    const outcome = await refreshGrant(provider(), world.mcpUrl);
    // Known-good endpoint refused the connection → the live endpoint was tried and worked.
    expect(outcome).toMatchObject({ kind: 'refreshed', persistence: 'persisted' });
    expect((await readGrant()).exchange).toBeUndefined();
    await expectUsableGrant();
  });
});

describe('OAuth lifecycle — authorization vs refresh', () => {
  async function authorizeB(p: InstanceType<typeof FileOAuthProvider>): Promise<void> {
    await p.beginAuthorization();
    await p.saveClientInformation({
      client_id: 'client-B',
      redirect_uris: [`http://127.0.0.1:${callbackPort}/oauth/callback`],
    });
    await p.saveTokens({
      access_token: 'at-B',
      token_type: 'Bearer',
      refresh_token: 'rt-B',
      expires_in: 3600,
    });
  }

  it('an authorization completing during a refresh waits for it; the stored pair stays coherent', async () => {
    await seedGrant();
    const p = provider();
    world.tokenDelayMs = 300;
    const refresh = refreshGrant(p, world.mcpUrl);
    await vi.waitFor(() => expect(refreshRequests()).toHaveLength(1), { interval: 10 });
    await p.runExclusive(() => authorizeB(p));
    expect(await refresh).toMatchObject({ kind: 'refreshed', persistence: 'persisted' });
    const data = await readGrant();
    expect(data.clientInfo.client_id).toBe('client-B');
    expect(data.tokens.refresh_token).toBe('rt-B');
    expect(data.pending).toBeUndefined();
  });

  it('a refresh result for a grant that was replaced meanwhile is archived, never mixed in', async () => {
    await seedGrant();
    const p = provider();
    world.tokenDelayMs = 300;
    const refresh = refreshGrant(p, world.mcpUrl);
    await vi.waitFor(() => expect(refreshRequests()).toHaveLength(1), { interval: 10 });
    await authorizeB(provider()); // a path that does not serialize (e.g. another instance)
    expect(await refresh).toMatchObject({ kind: 'refreshed', persistence: 'superseded' });
    const data = await readGrant();
    expect(data.clientInfo.client_id).toBe('client-B');
    expect(data.tokens.refresh_token).toBe('rt-B');
    await p.store.flushHistory();
    expect(await historyReasons()).toContain('superseded-refresh');
  });

  it('saveTokens() with the same access token but a different refresh token commits it', async () => {
    await seedGrant();
    const p = provider();
    const before = await readGrant();
    await p.beginAuthorization();
    await p.saveTokens({ ...before.tokens, refresh_token: 'rt-new' });
    const after = await readGrant();
    expect(after.tokens.refresh_token).toBe('rt-new');
    expect(after.pending).toBeUndefined();
    // A pure issuer stamp is still not a commit of anything else.
    await p.saveTokens({ ...after.tokens, issuer: 'https://stamp.example' });
    expect((await readGrant()).tokens.refresh_token).toBe('rt-new');
  });
});

describe('OAuth lifecycle — operator restore vs the running owner', () => {
  async function backups(): Promise<string[]> {
    const { data } = (await oauthCommand(['history', ID, '--dir', dir, '--json'])) as {
      data: { history: Array<{ version: string }> };
    };
    return data.history.map((h) => h.version);
  }

  it('is handed to the lock-holding process, which applies it between refreshes', async () => {
    setWriterLockTimings({ requestPollMs: 100 });
    const original = await seedGrant();
    world.reuseGraceMs = 0;
    const p = provider();
    await refreshGrant(p, world.mcpUrl); // this process now owns the store
    await p.store.flushHistory();
    const [version] = await backups();
    // Make the restored grant valid again at the AS so the case ends usable.
    world.validRefresh.set(original.refresh, { clientId: world.clientId });

    const cli = spawnTs([
      join(import.meta.dirname, '..', 'src', 'index.ts'),
      'oauth',
      'restore',
      ID,
      version,
      '--dir',
      dir,
      '--json',
      '--wait',
      '15',
    ]);
    const code = await cli.exited;
    const output = JSON.parse(cli.stdout()) as { via: string };
    expect(code).toBe(0);
    expect(output.via).toBe('applied by the lock holder');
    expect((await readGrant()).tokens.refresh_token).toBe(original.refresh);
    expect(await writerLockFor(dir).verify()).toBe(true); // never took the lock from the owner
    await expectUsableGrant();
  }, 30_000);

  it('refuses while a live holder does not answer, and never writes behind its back', async () => {
    await seedGrant();
    const p = provider();
    await refreshGrant(p, world.mcpUrl);
    await p.store.flushHistory();
    const [version] = await backups();
    await releaseAllWriterLocks();
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    children.push(holder);
    await writeForeignLock({ pid: holder.pid!, ns: lockNamespace() }, 5);
    const before = await readFile(tokenFile(), 'utf-8');

    const refused = await oauthCommand(['restore', ID, version, '--dir', dir, '--wait', '0.3']);
    expect(refused.exitCode).toBe(1);
    expect(refused.text).toContain('--force');
    expect(await readFile(tokenFile(), 'utf-8')).toBe(before);

    setWriterLockTimings({ takeoverGraceMs: 0 });
    const forced = await oauthCommand(['restore', ID, version, '--dir', dir, '--force']);
    expect(forced.exitCode).toBe(0);
    expect(forced.text).toContain('WARNING');
    expect((await readGrant()).tokens.refresh_token).not.toBe(
      JSON.parse(before).tokens.refresh_token
    );
  });

  it('is serialized with a refresh in flight (applied after its commit, not under it)', async () => {
    const original = await seedGrant();
    const p = provider();
    await refreshGrant(p, world.mcpUrl);
    await p.store.flushHistory();
    const [version] = await backups();
    world.tokenDelayMs = 300;
    const order: string[] = [];
    const refresh = refreshGrant(p, world.mcpUrl).then((o) => {
      order.push('refresh');
      return o;
    });
    await vi.waitFor(() => expect(refreshRequests()).toHaveLength(2), { interval: 10 });
    const restore = restoreGrant(dir, ID, version).then(() => order.push('restore'));
    await Promise.all([refresh, restore]);
    expect(order).toEqual(['refresh', 'restore']);
    expect((await readGrant()).tokens.refresh_token).toBe(original.refresh);
    // The in-memory provider follows the restored file instead of overwriting it.
    expect((await p.tokens())?.refresh_token).toBe(original.refresh);
  });
});

describe('OAuth lifecycle — idle grants', () => {
  it('refreshes an idle grant whose access token outlives the refresh-token inactivity window', async () => {
    await seedGrant();
    const data = await readGrant();
    // A 1-year access token obtained 25 h ago: expiry-based scheduling would wait ~a year.
    data.tokens.expires_in = 365 * 24 * 3600;
    data.obtainedAt = Date.now() - 25 * 3600 * 1000;
    await writeFile(tokenFile(), JSON.stringify(data));
    const p = provider();
    expect(await p.msUntilRefresh(5 * 60_000)).toBe(0);
    expect(await p.msUntilRefresh(5 * 60_000, 48 * 3600 * 1000)).toBeGreaterThan(22 * 3600 * 1000);

    const client = makeClient();
    await client.connect(); // schedules the proactive refresh (5 s floor)
    await vi.waitFor(() => expect(refreshRequests()).toHaveLength(1), {
      timeout: 9_000,
      interval: 100,
    });
    await vi.waitFor(() => expect(client.getOAuthHealth()?.lastRefreshAt).toBeDefined());
    expect(Date.now() - (await readGrant()).obtainedAt).toBeLessThan(10_000);
    await expectUsableGrant();
  }, 15_000);

  it('a grant without expires_in is still refreshed within the maximum interval', async () => {
    await seedGrant();
    const data = await readGrant();
    delete data.tokens.expires_in;
    await writeFile(tokenFile(), JSON.stringify(data));
    const ms = await provider().msUntilRefresh(5 * 60_000);
    expect(ms).toBeGreaterThan(23 * 3600 * 1000);
    expect(ms).toBeLessThanOrEqual(24 * 3600 * 1000);
  });
});
