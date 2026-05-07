import { mkdtemp, readFile, rm } from 'fs/promises';
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
});
