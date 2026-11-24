import { mkdtemp, rm } from 'fs/promises';
import { createConnection } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Prevent actual browser opens.
vi.mock('child_process', () => ({ execFile: vi.fn() }));

// Capture everything the OAuth modules log so tests can prove codes and states never appear.
const logged: unknown[] = [];
vi.mock('../src/util/logger.js', () => {
  const record =
    () =>
    (...args: unknown[]) => {
      logged.push(args);
    };
  const logger = {
    info: record(),
    warn: record(),
    error: record(),
    debug: record(),
    trace: record(),
    fatal: record(),
  };
  return { childLogger: () => logger, logger };
});

const { FileOAuthProvider } = await import('../src/pool/oauth-provider.js');
const { OAuthCallbackRouter } = await import('../src/pool/oauth-callback-router.js');
const { oauthCallbackPlugin } = await import('../src/transport/oauth-callback.js');
const { httpServerPlugin } = await import('../src/transport/http-server.js');

const CALLBACK_URL = 'https://airlock.example.com/oauth/callback';
const LOOPBACK_PORT = 18499;

type Provider = InstanceType<typeof FileOAuthProvider>;
type Router = InstanceType<typeof OAuthCallbackRouter>;

function gatewayProvider(id: string, router?: Router): Provider {
  return new FileOAuthProvider(id, LOOPBACK_PORT, undefined, undefined, CALLBACK_URL, {
    callbackMode: 'gateway',
    callbackRouter: router,
  });
}

/** Mimic the SDK: build the authorize URL with the provider's state, then hand it over. */
async function startAuthorization(provider: Provider): Promise<string> {
  const state = await provider.state!();
  const url = new URL('https://auth.example.com/authorize');
  url.searchParams.set('client_id', 'abc');
  url.searchParams.set('redirect_uri', provider.redirectUrl);
  url.searchParams.set('state', state);
  await provider.redirectToAuthorization(url);
  // The gateway never rewrites the state it routes by.
  expect(url.searchParams.get('state')).toBe(state);
  return state;
}

async function buildApp(router: Router, enabled = true): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(oauthCallbackPlugin, { router, isEnabled: () => enabled });
  return app;
}

function callback(app: FastifyInstance, params: Record<string, string>, method = 'GET') {
  const qs = new URLSearchParams(params).toString();
  return app.inject({ method: method as 'GET', url: `/oauth/callback${qs ? `?${qs}` : ''}` });
}

/** Resolve once `promise` settles, or report that it is still pending. */
async function settledState(promise: Promise<unknown>): Promise<'pending' | 'settled'> {
  return Promise.race([
    promise.then(
      () => 'settled' as const,
      () => 'settled' as const
    ),
    new Promise<'pending'>((r) => setTimeout(() => r('pending'), 20)),
  ]);
}

describe('OAuth gateway callback mode', () => {
  const originalHome = process.env.HOME;
  let tempHome: string;
  let router: Router;
  let app: FastifyInstance;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'airlock-oauth-gw-'));
    process.env.HOME = tempHome;
    logged.length = 0;
    router = new OAuthCallbackRouter();
    app = await buildApp(router);
  });

  afterEach(async () => {
    await app.close();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  it('advertises the public HTTPS callback and issues an unguessable state', async () => {
    const provider = gatewayProvider('spliit', router);
    expect(provider.redirectUrl).toBe(CALLBACK_URL);
    expect(provider.clientMetadata.redirect_uris).toEqual([CALLBACK_URL]);
    const a = provider.state!();
    const b = provider.state!();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it('delivers the code from the gateway route to the pending authorization', async () => {
    const provider = gatewayProvider('spliit', router);
    const state = await startAuthorization(provider);
    const code = provider.waitForAuthCode();

    const res = await callback(app, { code: 'auth-code-123', state });

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.body).not.toContain('auth-code-123');
    expect(res.body).not.toContain(state);
    await expect(code).resolves.toBe('auth-code-123');
    expect(router.pendingCount()).toBe(0);
  });

  it('does not bind a loopback listener in gateway mode', async () => {
    const provider = gatewayProvider('spliit', router);
    await startAuthorization(provider);
    void provider.waitForAuthCode();

    const refused = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ port: LOOPBACK_PORT, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('error', () => resolve(true));
    });
    expect(refused).toBe(true);
    provider.stopCallbackServer();
  });

  it('rejects a callback with an invalid state without disturbing the real authorization', async () => {
    const provider = gatewayProvider('spliit', router);
    const state = await startAuthorization(provider);
    const code = provider.waitForAuthCode();

    const forged = await callback(app, { code: 'attacker-code', state: 'not-the-state' });
    expect(forged.statusCode).toBe(400);
    const missing = await callback(app, { code: 'attacker-code' });
    expect(missing.statusCode).toBe(400);
    // An OAuth error is ignored too unless its state matches.
    const forgedError = await callback(app, { error: 'access_denied', state: 'nope' });
    expect(forgedError.statusCode).toBe(400);
    expect(await settledState(code)).toBe('pending');

    const real = await callback(app, { code: 'real-code', state });
    expect(real.statusCode).toBe(200);
    await expect(code).resolves.toBe('real-code');
  });

  it('rejects a replayed callback', async () => {
    const provider = gatewayProvider('spliit', router);
    const state = await startAuthorization(provider);
    const code = provider.waitForAuthCode();

    expect((await callback(app, { code: 'first', state })).statusCode).toBe(200);
    await expect(code).resolves.toBe('first');

    const replay = await callback(app, { code: 'first', state });
    expect(replay.statusCode).toBe(400);
    expect(replay.body).toContain('already used');
  });

  it('keeps the authorization pending when a matching callback carries neither code nor error', async () => {
    const provider = gatewayProvider('spliit', router);
    const state = await startAuthorization(provider);
    const code = provider.waitForAuthCode();

    expect((await callback(app, { state })).statusCode).toBe(400);
    expect(await settledState(code)).toBe('pending');
    expect((await callback(app, { code: 'late', state })).statusCode).toBe(200);
    await expect(code).resolves.toBe('late');
  });

  it('fails only the matching authorization on an OAuth error and sanitizes the code', async () => {
    const provider = gatewayProvider('spliit', router);
    const state = await startAuthorization(provider);
    const code = provider.waitForAuthCode();
    const rejected = expect(code).rejects.toThrow('OAuth error: access_denied');

    const res = await callback(app, { error: 'access_denied', state });
    expect(res.statusCode).toBe(200);
    await rejected;

    const other = gatewayProvider('trek', router);
    const otherState = await startAuthorization(other);
    const otherCode = other.waitForAuthCode();
    const sanitized = expect(otherCode).rejects.toThrow('OAuth error: invalid_request');
    await callback(app, { error: '<script>alert(1)</script>', state: otherState });
    await sanitized;
  });

  it('routes concurrent providers sharing one callback URL by state', async () => {
    const spliit = gatewayProvider('spliit', router);
    const trek = gatewayProvider('trek', router);
    const spliitState = await startAuthorization(spliit);
    const trekState = await startAuthorization(trek);
    const spliitCode = spliit.waitForAuthCode();
    const trekCode = trek.waitForAuthCode();
    expect(router.pendingCount()).toBe(2);

    // Completed out of order: each code reaches only its own provider.
    expect((await callback(app, { code: 'trek-code', state: trekState })).statusCode).toBe(200);
    expect(await settledState(spliitCode)).toBe('pending');
    await expect(trekCode).resolves.toBe('trek-code');

    // A provider's state cannot complete another provider's flow a second time.
    expect((await callback(app, { code: 'x', state: trekState })).statusCode).toBe(400);

    expect((await callback(app, { code: 'spliit-code', state: spliitState })).statusCode).toBe(200);
    await expect(spliitCode).resolves.toBe('spliit-code');
  });

  it('supersedes an earlier authorization when the provider prepares a new one', async () => {
    const provider = gatewayProvider('spliit', router);
    const stale = await startAuthorization(provider);
    const code = provider.waitForAuthCode();
    const fresh = await startAuthorization(provider);
    expect(router.pendingCount()).toBe(1);

    expect((await callback(app, { code: 'old', state: stale })).statusCode).toBe(400);
    expect((await callback(app, { code: 'new', state: fresh })).statusCode).toBe(200);
    // The flow already awaiting a code receives the current authorization's code.
    await expect(code).resolves.toBe('new');
  });

  it('withdraws the pending state when the flow is abandoned', async () => {
    const provider = gatewayProvider('spliit', router);
    const state = await startAuthorization(provider);
    void provider.waitForAuthCode();
    provider.stopCallbackServer();

    expect(router.pendingCount()).toBe(0);
    expect((await callback(app, { code: 'late', state })).statusCode).toBe(400);
  });

  it('never logs authorization codes, states or callback query strings', async () => {
    const provider = gatewayProvider('spliit', router);
    const state = await startAuthorization(provider);
    const code = provider.waitForAuthCode();
    logged.length = 0; // The authorize URL (logged for the operator) legitimately has the state.

    await callback(app, { code: 'secret-code-xyz', state: 'forged-state-abc' });
    await callback(app, { code: 'secret-code-xyz', state });
    await expect(code).resolves.toBe('secret-code-xyz');

    const text = JSON.stringify(logged);
    expect(text).not.toContain('secret-code-xyz');
    expect(text).not.toContain('forged-state-abc');
    expect(text).not.toContain(state);
    expect(logged.length).toBeGreaterThan(0);
  });

  it('answers 404 while no provider opts in, and never serves HEAD', async () => {
    const disabled = await buildApp(new OAuthCallbackRouter(), false);
    try {
      expect((await callback(disabled, { code: 'c', state: 's' })).statusCode).toBe(404);
    } finally {
      await disabled.close();
    }

    const provider = gatewayProvider('spliit', router);
    const state = await startAuthorization(provider);
    const code = provider.waitForAuthCode();
    const head = await callback(app, { code: 'c', state }, 'HEAD');
    expect(head.statusCode).toBe(404);
    expect(await settledState(code)).toBe('pending');
    provider.stopCallbackServer();
  });

  it('reports a clear error when no gateway listener serves the callback', async () => {
    const provider = gatewayProvider('spliit');
    await startAuthorization(provider);
    await expect(provider.waitForAuthCode()).rejects.toThrow('oauth_callback_mode: gateway');
  });

  it('requires oauth_callback_url', () => {
    expect(
      () =>
        new FileOAuthProvider('spliit', LOOPBACK_PORT, undefined, undefined, undefined, {
          callbackMode: 'gateway',
          callbackRouter: router,
        })
    ).toThrow('without oauth_callback_url');
  });

  it('is reachable without agent credentials while the MCP route keeps requiring them', async () => {
    const shared = Fastify({ logger: false });
    await shared.register(httpServerPlugin, {
      // Only the auth check runs for a request without credentials; it reads agentConfig alone.
      getDeps: (agentId: string) =>
        agentId === 'test' ? ({ agentId, agentConfig: {} } as never) : undefined,
      secret: 'gateway-secret',
      authRequired: true,
    });
    await shared.register(oauthCallbackPlugin, { router, isEnabled: () => true });
    try {
      const provider = gatewayProvider('spliit', router);
      const state = await startAuthorization(provider);
      const code = provider.waitForAuthCode();

      const mcp = await shared.inject({
        method: 'POST',
        url: '/agents/test/mcp',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      expect(mcp.statusCode).toBe(401);

      const res = await callback(shared, { code: 'ok', state });
      expect(res.statusCode).toBe(200);
      await expect(code).resolves.toBe('ok');
    } finally {
      await shared.close();
    }
  });
});

describe('OAuth loopback mode is unchanged', () => {
  const originalHome = process.env.HOME;
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'airlock-oauth-lb-'));
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  it('leaves state generation to the SDK and still completes on the loopback listener', async () => {
    const provider = new FileOAuthProvider('loopback', LOOPBACK_PORT);
    expect(provider.state).toBeUndefined();
    expect(provider.redirectUrl).toBe(`http://127.0.0.1:${LOOPBACK_PORT}/oauth/callback`);

    await provider.redirectToAuthorization(
      new URL('https://auth.example.com/authorize?client_id=abc&state=sdk-state')
    );
    const code = provider.waitForAuthCode();
    const res = await fetch(
      `http://127.0.0.1:${LOOPBACK_PORT}/oauth/callback?code=loop-code&state=sdk-state`
    );
    expect(res.status).toBe(200);
    await expect(code).resolves.toBe('loop-code');
  });

  it('keeps the legacy relay contract: port-wrapped state on the advertised relay URL', async () => {
    // A separate port: the previous test's listener may still hold a keep-alive connection.
    const port = LOOPBACK_PORT + 1;
    const provider = new FileOAuthProvider('relay', port, undefined, undefined, CALLBACK_URL);
    expect(provider.state).toBeUndefined();
    expect(provider.redirectUrl).toBe(CALLBACK_URL);
    const url = new URL('https://auth.example.com/authorize?client_id=abc&state=sdk-state');
    await provider.redirectToAuthorization(url);
    expect(url.searchParams.get('state')).toBe(`${port}.sdk-state`);

    const code = provider.waitForAuthCode();
    const res = await fetch(
      `http://127.0.0.1:${port}/oauth/callback?code=relayed&state=${port}.sdk-state`
    );
    expect(res.status).toBe(200);
    await expect(code).resolves.toBe('relayed');
  });
});
