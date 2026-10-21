import { TemporarilyUnavailableError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { OAuthTokensSchema } from '@modelcontextprotocol/sdk/shared/auth.js';

const OAUTH_REQUEST_TIMEOUT_MS = 15_000;

/**
 * The SDK falls through to browser authorization when refresh fails with a network error,
 * ServerError, or malformed token response. A headless gateway must retry those failures instead.
 * TemporarilyUnavailableError is an OAuthError that the SDK propagates without deleting tokens
 * or opening a browser. Only an issuer's explicit invalid_grant/client response should do that.
 */
export async function oauthFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const timeout = AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const tokenRequest = init?.body instanceof URLSearchParams && init.body.has('grant_type');
  try {
    const response = await fetch(url, { ...init, signal });
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      await response.body?.cancel();
      throw new TemporarilyUnavailableError(
        `OAuth endpoint temporarily unavailable (${response.status})`
      );
    }
    if (tokenRequest) {
      // Consume the bounded response here: a stalled body or malformed 200 must not fall through
      // the SDK's broad refresh catch into permanent interactive authorization either.
      const body = await response.text();
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        throw new TemporarilyUnavailableError('OAuth endpoint returned invalid JSON');
      }
      if (response.ok) {
        if (!OAuthTokensSchema.safeParse(payload).success) {
          throw new TemporarilyUnavailableError(
            'OAuth endpoint returned an invalid token response'
          );
        }
      } else {
        const error = (payload as { error?: unknown } | null)?.error;
        if (typeof error !== 'string' || error === 'server_error') {
          throw new TemporarilyUnavailableError('OAuth endpoint returned a temporary error');
        }
      }
      return new Response(body, { status: response.status, headers: response.headers });
    }
    return response;
  } catch (error) {
    if (error instanceof TemporarilyUnavailableError) throw error;
    // Do not include endpoint response bodies, request data, or credentials in error messages.
    throw new TemporarilyUnavailableError('OAuth network request failed or timed out');
  }
}

/** Keep long-lived MCP event streams and ordinary tool requests outside the OAuth timeout. */
export function oauthTransportFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  if (init?.body instanceof URLSearchParams || new URL(url).pathname.includes('/.well-known/')) {
    return oauthFetch(url, init);
  }
  return fetch(url, init);
}
