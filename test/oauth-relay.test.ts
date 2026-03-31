import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FileOAuthProvider } from '../src/pool/oauth-provider.js';

// Prevent actual browser opens
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

describe('FileOAuthProvider — relay callback URL', () => {
  const RELAY_URL = 'https://auth.airlock.bot/callback';
  const PORT = 18432;

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

    it('does not wrap state when state param is absent', async () => {
      const provider = new FileOAuthProvider('test-server', PORT, undefined, undefined, RELAY_URL);
      const url = new URL('https://oauth.example.com/authorize?client_id=abc');
      await provider.redirectToAuthorization(url);
      expect(url.searchParams.has('state')).toBe(false);
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
