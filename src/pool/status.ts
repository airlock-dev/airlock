export type ProviderConnectionState = 'up' | 'connecting' | 'down' | 'auth_required';

/**
 * State of an Airlock-held OAuth grant (providers with `oauth: true`).
 *
 * - `ok`: last refresh (or authorization) succeeded.
 * - `refresh_failing`: refresh attempts are failing for a non-rejection reason (network, 5xx,
 *   timeout, discovery outage, malformed response). Retried with backoff forever.
 * - `grant_rejected`: the issuer explicitly rejected the stored grant (invalid_grant & co). The
 *   grant is kept on disk and refresh keeps being retried with backoff; a browser authorization is
 *   also offered. Only a successful refresh, a new authorization, or an operator restore clears it.
 * - `missing`: no refresh token stored; only an interactive authorization can create a grant.
 * - `read_only`: this process may not refresh (read-only CLI, or another process owns the store).
 */
export type OAuthGrantState = 'ok' | 'refresh_failing' | 'grant_rejected' | 'missing' | 'read_only';

export interface OAuthGrantHealth {
  state: OAuthGrantState;
  storage: 'writer' | 'readonly';
  consecutiveFailures: number;
  lastError?: string;
  lastErrorAt?: string;
  lastRefreshAt?: string;
  nextRetryAt?: string;
  issuer?: string;
  /** Set when discovery reported a different issuer than the one that issued the stored grant. */
  issuerChanged?: { from: string; to: string; at: string };
  /** A browser authorization URL has been prepared and its callback is being awaited. */
  authorizationPending: boolean;
}

export interface ProviderConnectionStatus {
  status: ProviderConnectionState;
  reason?: string;
  /** Present for OAuth providers whose grant needs attention. */
  oauth?: OAuthGrantHealth;
}
