import { afterEach, describe, expect, it, vi } from 'vitest';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { TemporarilyUnavailableError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { oauthFetch, oauthTransportFetch } from '../src/pool/oauth-fetch.js';

afterEach(() => vi.unstubAllGlobals());

function provider() {
  let tokens: OAuthTokens | undefined = {
    access_token: 'old-access',
    refresh_token: 'valid-refresh',
    token_type: 'Bearer',
  };
  const p = {
    redirectUrl: 'http://localhost:18434/oauth/callback',
    clientMetadata: { redirect_uris: ['http://localhost:18434/oauth/callback'] },
    clientInformation: vi.fn(async () => ({ client_id: 'test-client' })),
    tokens: vi.fn(async () => tokens),
    saveTokens: vi.fn(async (next: OAuthTokens) => {
      tokens = next;
    }),
    invalidateCredentials: vi.fn(async () => {
      tokens = undefined;
    }),
    redirectToAuthorization: vi.fn(async () => {}),
    saveCodeVerifier: vi.fn(async () => {}),
    codeVerifier: vi.fn(async () => 'test-verifier'),
    discoveryState: async () => ({
      authorizationServerUrl: 'https://issuer.test',
      authorizationServerMetadata: {
        issuer: 'https://issuer.test',
        authorization_endpoint: 'https://issuer.test/authorize',
        token_endpoint: 'https://issuer.test/token',
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
      },
      resourceMetadata: { resource: 'https://mcp.test/' },
    }),
  } satisfies OAuthClientProvider;
  return p;
}

describe('OAuth refresh through the real SDK', () => {
  it.each([
    [
      'network failure',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
    ['rate limit', () => new Response('rate limited', { status: 429 })],
    ['request timeout', () => new Response('timeout', { status: 408 })],
    ['server failure', () => new Response('unavailable', { status: 503 })],
    ['OAuth server_error', () => Response.json({ error: 'server_error' }, { status: 400 })],
    ['invalid JSON', () => new Response('<html>upstream error</html>')],
    ['invalid tokens', () => Response.json({ status: 'error' })],
  ])(
    'retries after %s without discarding tokens or requiring a browser',
    async (_name, failure) => {
      const p = provider();
      const request = vi
        .fn()
        .mockImplementationOnce(failure)
        .mockResolvedValueOnce(
          Response.json({
            access_token: 'new-access',
            refresh_token: 'rotated-refresh',
            token_type: 'Bearer',
          })
        );
      vi.stubGlobal('fetch', request);
      const options = { serverUrl: 'https://mcp.test/', fetchFn: oauthFetch };
      await expect(auth(p, options)).rejects.toBeInstanceOf(TemporarilyUnavailableError);
      expect(p.invalidateCredentials).not.toHaveBeenCalled();
      expect(p.redirectToAuthorization).not.toHaveBeenCalled();
      expect((await p.tokens())?.refresh_token).toBe('valid-refresh');
      await expect(auth(p, options)).resolves.toBe('AUTHORIZED');
      expect((await p.tokens())?.refresh_token).toBe('rotated-refresh');
    }
  );

  it('still requires authorization for an explicitly revoked grant', async () => {
    const p = provider();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ error: 'invalid_grant' }, { status: 400 }))
    );
    await expect(auth(p, { serverUrl: 'https://mcp.test/', fetchFn: oauthFetch })).resolves.toBe(
      'REDIRECT'
    );
    expect(p.invalidateCredentials).toHaveBeenCalledWith('tokens');
    expect(p.redirectToAuthorization).toHaveBeenCalledOnce();
  });

  it('bounds OAuth requests and preserves caller cancellation', async () => {
    const controller = new AbortController();
    const request = vi.fn(async (_url, init) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      controller.abort();
      expect(init.signal.aborted).toBe(true);
      throw new DOMException('aborted', 'AbortError');
    });
    vi.stubGlobal('fetch', request);
    await expect(
      oauthFetch('https://issuer.test/token', {
        signal: controller.signal,
        body: new URLSearchParams({ grant_type: 'refresh_token' }),
      })
    ).rejects.toBeInstanceOf(TemporarilyUnavailableError);
  });

  it('applies the same protection to reactive transport refresh without timing out MCP streams', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(''));
    vi.stubGlobal('fetch', request);
    await expect(
      oauthTransportFetch('https://issuer.test/token', {
        body: new URLSearchParams({ grant_type: 'refresh_token' }),
      })
    ).rejects.toBeInstanceOf(TemporarilyUnavailableError);
    const init = { method: 'GET', headers: { Accept: 'text/event-stream' } };
    await oauthTransportFetch('https://mcp.test/mcp', init);
    expect(request).toHaveBeenLastCalledWith('https://mcp.test/mcp', init);
  });
});
