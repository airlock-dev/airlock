/**
 * Tests for ClientCredentialsTokenSource — the OAuth2 client-credentials grant, i.e. the gateway
 * authenticating as the APPLICATION rather than as a user.
 *
 * The properties worth pinning down are the ones that cost real quota or real downtime when they
 * regress: tokens survive a restart (issuers cap concurrent tokens per app), a burst of callers
 * mints once, expiry is honoured with a safety buffer, and a rejected secret is distinguishable
 * from a flaky issuer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ClientCredentialsTokenSource } from '../src/pool/client-credentials.js';

const CFG = {
  token_url: 'https://issuer.example/oauth/token',
  client_id: 'cid',
  client_secret: 'csecret',
  scope: 'read,write',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let storeDir: string;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  storeDir = await mkdtemp(join(tmpdir(), 'airlock-cc-'));
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('ClientCredentialsTokenSource', () => {
  it('mints with HTTP Basic auth and the configured scope', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ access_token: 'tok-1', expires_in: 3600 }));

    const source = new ClientCredentialsTokenSource('linearBot', CFG, storeDir);
    expect(await source.getToken()).toBe('tok-1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(CFG.token_url);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('cid:csecret').toString('base64')}`);
    expect(String(init.body)).toBe('grant_type=client_credentials&scope=read%2Cwrite');
  });

  it('reuses a cached token instead of minting again', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ access_token: 'tok-1', expires_in: 3600 }));

    const source = new ClientCredentialsTokenSource('linearBot', CFG, storeDir);
    await source.getToken();
    await source.getToken();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('mints once for concurrent callers on a cold cache', async () => {
    // The quota case: a reconnect storm must not spend one token per in-flight request.
    fetchMock.mockResolvedValue(jsonResponse({ access_token: 'tok-1', expires_in: 3600 }));

    const source = new ClientCredentialsTokenSource('linearBot', CFG, storeDir);
    const tokens = await Promise.all([source.getToken(), source.getToken(), source.getToken()]);

    expect(tokens).toEqual(['tok-1', 'tok-1', 'tok-1']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('persists the token so a restart does not burn a fresh one', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ access_token: 'tok-1', expires_in: 3600 }));

    await new ClientCredentialsTokenSource('linearBot', CFG, storeDir).getToken();
    // A second instance stands in for a gateway restart: same store, same provider id.
    const revived = new ClientCredentialsTokenSource('linearBot', CFG, storeDir);

    expect(await revived.getToken()).toBe('tok-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('writes the token file 0600', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ access_token: 'tok-1', expires_in: 3600 }));

    const source = new ClientCredentialsTokenSource('linearBot', CFG, storeDir);
    await source.getToken();

    const { stat } = await import('fs/promises');
    const mode = (await stat(join(storeDir, 'linearBot.client-credentials.json'))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('re-mints inside the expiry buffer', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok-1', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok-2', expires_in: 3600 }));

    vi.useFakeTimers();
    const source = new ClientCredentialsTokenSource('linearBot', CFG, storeDir);
    expect(await source.getToken()).toBe('tok-1');

    // 3595s in: inside the 5-minute buffer, so the token is treated as spent even though the
    // issuer would still accept it.
    vi.setSystemTime(Date.now() + 3595_000);
    expect(await source.getToken()).toBe('tok-2');
  });

  it('does not continuously mint when the token lifetime is only five minutes', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok-1', expires_in: 300 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok-2', expires_in: 300 }));

    vi.useFakeTimers();
    const now = Date.now();
    const source = new ClientCredentialsTokenSource('linearBot', CFG, storeDir);
    expect(await source.getToken()).toBe('tok-1');
    expect(await source.getToken()).toBe('tok-1');

    vi.setSystemTime(now + 269_000);
    expect(await source.getToken()).toBe('tok-1');
    vi.setSystemTime(now + 271_000);
    expect(await source.getToken()).toBe('tok-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('holds a token with no declared expiry until forced', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok-1' }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok-2' }));

    const source = new ClientCredentialsTokenSource('linearBot', CFG, storeDir);
    expect(await source.getToken()).toBe('tok-1');
    expect(await source.getToken()).toBe('tok-1');
    expect(await source.getToken(true)).toBe('tok-2');
  });

  it('discards a cached token minted for different scopes', async () => {
    await writeFile(
      join(storeDir, 'linearBot.client-credentials.json'),
      JSON.stringify({ access_token: 'stale', expires_at: Date.now() + 3600_000, scope: 'read' })
    );
    fetchMock.mockResolvedValue(jsonResponse({ access_token: 'tok-fresh', expires_in: 3600 }));

    const source = new ClientCredentialsTokenSource('linearBot', CFG, storeDir);
    expect(await source.getToken()).toBe('tok-fresh');
  });

  it('records invalid_client as an auth failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid_client' }, 401));

    const source = new ClientCredentialsTokenSource('linearBot', CFG, storeDir);
    await expect(source.getToken()).rejects.toThrow(/invalid_client/);
    expect(source.lastAuthFailure).toMatch(/invalid_client/);
  });

  it('does not blame the credentials for a transient issuer failure', async () => {
    fetchMock.mockResolvedValue(new Response('upstream boom', { status: 503 }));

    const source = new ClientCredentialsTokenSource('linearBot', CFG, storeDir);
    await expect(source.getToken()).rejects.toThrow(/503/);
    // A 503 says nothing about the secret — reporting auth_required here would send someone off
    // rotating a perfectly good credential.
    expect(source.lastAuthFailure).toBeUndefined();
  });

  it('clears a previous auth failure once a mint succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'invalid_client' }, 401))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok-1', expires_in: 3600 }));

    const source = new ClientCredentialsTokenSource('linearBot', CFG, storeDir);
    await expect(source.getToken()).rejects.toThrow();
    await source.getToken();

    expect(source.lastAuthFailure).toBeUndefined();
  });

  it('retries after a failed mint rather than caching the failure', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok-1', expires_in: 3600 }));

    const source = new ClientCredentialsTokenSource('linearBot', CFG, storeDir);
    await expect(source.getToken()).rejects.toThrow(/ECONNREFUSED/);
    expect(await source.getToken()).toBe('tok-1');
  });

  it('rejects a token response with no access_token', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ token_type: 'Bearer' }));

    const source = new ClientCredentialsTokenSource('linearBot', CFG, storeDir);
    await expect(source.getToken()).rejects.toThrow(/no access_token/);
  });

  it('omits scope when none is configured', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ access_token: 'tok-1', expires_in: 3600 }));

    const { scope: _scope, ...noScope } = CFG;
    await new ClientCredentialsTokenSource('linearBot', noScope, storeDir).getToken();

    expect(String(fetchMock.mock.calls[0][1].body)).toBe('grant_type=client_credentials');
  });

  it('survives an unwritable store by holding the token in memory', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ access_token: 'tok-1', expires_in: 3600 }));

    const source = new ClientCredentialsTokenSource(
      'linearBot',
      CFG,
      join(storeDir, 'not-a-dir\0bad')
    );
    expect(await source.getToken()).toBe('tok-1');
  });

  it('ignores a corrupt cache file', async () => {
    await writeFile(join(storeDir, 'linearBot.client-credentials.json'), '{ not json');
    fetchMock.mockResolvedValue(jsonResponse({ access_token: 'tok-1', expires_in: 3600 }));

    const source = new ClientCredentialsTokenSource('linearBot', CFG, storeDir);
    expect(await source.getToken()).toBe('tok-1');
  });

  it('stores the expiry it was told, not a guess', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    fetchMock.mockResolvedValue(jsonResponse({ access_token: 'tok-1', expires_in: 2_592_000 }));

    await new ClientCredentialsTokenSource('linearBot', CFG, storeDir).getToken();

    const saved = JSON.parse(
      await readFile(join(storeDir, 'linearBot.client-credentials.json'), 'utf-8')
    ) as { expires_at: number };
    expect(saved.expires_at).toBe(now + 2_592_000_000);
  });
});
