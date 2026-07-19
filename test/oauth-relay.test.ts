import { mkdtemp, readFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FileOAuthProvider } from '../src/pool/oauth-provider.js';

// Prevent actual browser opens
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

describe('FileOAuthProvider — relay callback URL', () => {
  const RELAY_URL = 'https://auth.airlock.bot/callback';
  const PORT = 18432;
  const originalHome = process.env.HOME;
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'airlock-oauth-'));
    process.env.HOME = tempHome;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(tempHome, { recursive: true, force: true });
  });

  describe('without relay', () => {
    it('uses localhost redirect URL', () => {
      const provider = new FileOAuthProvider('test-server', PORT);
      expect(provider.redirectUrl).toBe(`http://127.0.0.1:${PORT}/oauth/callback`);
    });

    it('does not modify state in redirectToAuthorization', async () => {
      const provider = new FileOAuthProvider('test-server', PORT);
      const url = new URL('https://oauth.example.com/authorize?state=original&client_id=abc');
      await provider.redirectToAuthorization(url);
      expect(url.searchParams.get('state')).toBe('original');
    });

    it('reuses cached client registration when redirect URL matches', async () => {
      const provider = new FileOAuthProvider('matching-server', PORT);
      await provider.saveClientInformation({
        client_id: 'client-123',
        redirect_uris: [provider.redirectUrl],
      });

      await expect(provider.clientInformation()).resolves.toMatchObject({
        client_id: 'client-123',
        redirect_uris: [provider.redirectUrl],
      });
    });

    it('stores OAuth cache files with owner-only permissions', async () => {
      const serverId = 'private-store';
      const provider = new FileOAuthProvider(serverId, PORT);
      await provider.saveTokens({ access_token: 'secret-token', token_type: 'Bearer' });

      const dirInfo = await stat(join(tempHome, '.airlock', 'oauth'));
      const fileInfo = await stat(join(tempHome, '.airlock', 'oauth', `${serverId}.json`));
      expect(dirInfo.mode & 0o777).toBe(0o700);
      expect(fileInfo.mode & 0o777).toBe(0o600);
    });

    it('drops cached client registration when redirect URL changes', async () => {
      const serverId = 'stale-server';
      const staleProvider = new FileOAuthProvider(serverId, PORT);
      await staleProvider.saveClientInformation({
        client_id: 'stale-client',
        redirect_uris: [staleProvider.redirectUrl],
      });
      await staleProvider.saveTokens({ access_token: 'old-token', token_type: 'Bearer' });

      const provider = new FileOAuthProvider(serverId, PORT + 1);
      await expect(provider.clientInformation()).resolves.toBeUndefined();

      const stored = JSON.parse(
        await readFile(join(tempHome, '.airlock', 'oauth', `${serverId}.json`), 'utf-8')
      );
      expect(stored).toEqual({});
    });
  });

  describe('with relay', () => {
    it('uses relay URL as redirect URL', () => {
      const provider = new FileOAuthProvider('test-server', PORT, undefined, undefined, RELAY_URL);
      expect(provider.redirectUrl).toBe(RELAY_URL);
    });

    it('includes relay URL in client metadata redirect_uris', () => {
      const provider = new FileOAuthProvider('test-server', PORT, undefined, undefined, RELAY_URL);
      expect(provider.clientMetadata.redirect_uris).toEqual([RELAY_URL]);
    });

    it('wraps state with port in redirectToAuthorization', async () => {
      const provider = new FileOAuthProvider('test-server', PORT, undefined, undefined, RELAY_URL);
      const url = new URL('https://oauth.example.com/authorize?state=origstate&client_id=abc');
      await provider.redirectToAuthorization(url);
      expect(url.searchParams.get('state')).toBe(`${PORT}.origstate`);
    });

    it('preserves state values containing dots', async () => {
      const provider = new FileOAuthProvider('test-server', PORT, undefined, undefined, RELAY_URL);
      const url = new URL('https://oauth.example.com/authorize?state=a.b.c&client_id=abc');
      await provider.redirectToAuthorization(url);
      expect(url.searchParams.get('state')).toBe(`${PORT}.a.b.c`);
    });

    it('wraps port even when state param is absent', async () => {
      const provider = new FileOAuthProvider('test-server', PORT, undefined, undefined, RELAY_URL);
      const url = new URL('https://oauth.example.com/authorize?client_id=abc');
      await provider.redirectToAuthorization(url);
      expect(url.searchParams.get('state')).toBe(`${PORT}.`);
    });

    it('wraps port when state param is empty', async () => {
      const provider = new FileOAuthProvider('test-server', PORT, undefined, undefined, RELAY_URL);
      const url = new URL('https://oauth.example.com/authorize?state=&client_id=abc');
      await provider.redirectToAuthorization(url);
      expect(url.searchParams.get('state')).toBe(`${PORT}.`);
    });

    it('includes relay URL in pre-registered client info redirect_uris', async () => {
      const provider = new FileOAuthProvider(
        'test-server',
        PORT,
        'my-client-id',
        'my-secret',
        RELAY_URL
      );
      const info = await provider.clientInformation();
      expect(info?.redirect_uris).toEqual([RELAY_URL]);
    });
  });

  describe('callback state validation', () => {
    it('accepts a stateless callback when the authorize request carried no state', async () => {
      // Mirrors Railway: the authorize URL has no `state`, so the real callback has none either.
      const provider = new FileOAuthProvider('stateless-server', PORT);
      await provider.redirectToAuthorization(
        new URL('https://oauth.example.com/authorize?client_id=abc')
      );

      const codePromise = provider.waitForAuthCode();
      const res = await fetch(
        `http://127.0.0.1:${PORT}/oauth/callback?code=the-code&iss=https%3A%2F%2Fissuer`
      );

      expect(res.status).toBe(200);
      await expect(codePromise).resolves.toBe('the-code');
    });

    it('still rejects a mismatched state when the authorize request carried state', async () => {
      const provider = new FileOAuthProvider('stateful-server', PORT + 1);
      await provider.redirectToAuthorization(
        new URL('https://oauth.example.com/authorize?client_id=abc&state=expected')
      );

      const codePromise = provider.waitForAuthCode();
      // Attach the rejection assertion before triggering the callback so the rejection is never
      // momentarily unhandled (the server settles it mid-fetch, before the await below is reached).
      const rejects = expect(codePromise).rejects.toThrow('OAuth state mismatch');
      const res = await fetch(
        `http://127.0.0.1:${PORT + 1}/oauth/callback?code=x&state=wrong`
      );

      expect(res.status).toBe(400);
      await rejects;
    });
  });
});
