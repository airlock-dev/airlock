import { childLogger } from '../util/logger.js';

const log = childLogger('oauth-callback');

/** What the browser callback delivered to the pending authorization it matched. */
export type OAuthCallbackOutcome = { code: string } | { error: string };

export interface OAuthCallbackResponse {
  status: number;
  /** Short, fixed HTML that never echoes the request. */
  html: string;
}

interface PendingAuthorization {
  providerId: string;
  settle: (outcome: OAuthCallbackOutcome) => void;
}

// OAuth error codes are short ASCII tokens (RFC 6749 §4.1.2.1). Anything else is replaced rather
// than carried into an Error message that ends up in logs and provider status.
const OAUTH_ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

function page(title: string, detail: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h2>${title}</h2><p>${detail}</p></body></html>`;
}

const UNKNOWN_STATE: OAuthCallbackResponse = {
  status: 400,
  html: page(
    'Authorization failed',
    'This authorization link is unknown, expired or was already used. Start the sign-in again from Airlock.'
  ),
};

/**
 * Routes OAuth browser callbacks received by the gateway's own HTTP listener to the pending
 * authorization that issued the matching `state`.
 *
 * Each pending authorization is keyed by the unguessable `state` its provider generated for the
 * authorize request. A callback is handled only when its `state` matches an entry, and the entry is
 * removed before the outcome is delivered, so a replayed or forged callback reaches nothing. Several
 * providers can share one public callback URL: the state alone selects the provider.
 */
export class OAuthCallbackRouter {
  private pending = new Map<string, PendingAuthorization>();

  /**
   * Wait for the callback carrying `state`. Registering again for the same provider supersedes its
   * previous authorization. Returns a function that withdraws this registration.
   */
  register(
    state: string,
    providerId: string,
    settle: (outcome: OAuthCallbackOutcome) => void
  ): () => void {
    if (!state) throw new Error('OAuth gateway callbacks require a non-empty state');
    for (const [existingState, entry] of this.pending) {
      if (entry.providerId === providerId) this.pending.delete(existingState);
    }
    const entry: PendingAuthorization = { providerId, settle };
    this.pending.set(state, entry);
    return () => {
      if (this.pending.get(state) === entry) this.pending.delete(state);
    };
  }

  /** Number of authorizations currently waiting for a browser callback. */
  pendingCount(): number {
    return this.pending.size;
  }

  /** Handle one browser callback. Never logs the code, state or query string. */
  handle(query: URLSearchParams): OAuthCallbackResponse {
    const state = query.get('state');
    const entry = state ? this.pending.get(state) : undefined;
    if (!state || !entry) {
      log.warn('Rejected OAuth callback with unknown or missing state');
      return UNKNOWN_STATE;
    }

    const error = query.get('error');
    const code = query.get('code');
    if (!error && !code) {
      // Leave the authorization pending: a malformed request must not cancel a real sign-in.
      return {
        status: 400,
        html: page('Authorization failed', 'The callback did not include an authorization code.'),
      };
    }

    // Single use: consume before settling so a replay of this exact callback finds nothing.
    this.pending.delete(state);

    if (error) {
      const safeError = OAUTH_ERROR_CODE.test(error) ? error : 'invalid_request';
      log.warn(
        { providerId: entry.providerId, error: safeError },
        'OAuth authorization was refused'
      );
      entry.settle({ error: safeError });
      return { status: 200, html: page('Authorization failed', 'You can close this tab.') };
    }

    log.info({ providerId: entry.providerId }, 'Received OAuth authorization callback');
    entry.settle({ code: code! });
    return { status: 200, html: page('Authorized!', 'You can close this tab.') };
  }
}

/** Security headers for callback pages: never cache, never leak the URL, never run content. */
export const OAUTH_CALLBACK_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
};
