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
 * - `refresh_ambiguous`: a refresh request may have reached the issuer but its answer was lost
 *   (timeout, reset after sending, 502/504), or a previous process stopped mid-exchange. The issuer
 *   may have rotated the refresh token. The stored token is retried at the same endpoint only; an
 *   issuer that strictly enforces single use cannot be recovered client-side from this and will
 *   then answer `invalid_grant` (→ `grant_rejected`, browser re-authorization).
 * - `persistence_pending`: a refresh succeeded but the new grant could not be written to disk yet.
 *   It is used from memory and the write is retried; no refresh token is spent meanwhile.
 * - `missing`: no refresh token stored; only an interactive authorization can create a grant.
 * - `read_only`: this process may not refresh (read-only CLI, or another process owns the store).
 */
export type OAuthGrantState =
  | 'ok'
  | 'refresh_failing'
  | 'refresh_ambiguous'
  | 'persistence_pending'
  | 'grant_rejected'
  | 'missing'
  | 'read_only';

export interface OAuthGrantHealth {
  state: OAuthGrantState;
  storage: 'writer' | 'readonly';
  consecutiveFailures: number;
  lastError?: string;
  lastErrorAt?: string;
  lastRefreshAt?: string;
  nextRetryAt?: string;
  issuer?: string;
  /**
   * Set when discovery reported a different issuer than the one that issued the stored grant.
   * `migrated` is true once the grant was refreshed at the new issuer; until then refreshes stay
   * at the endpoint that last worked.
   */
  issuerChanged?: { from: string; to: string; migrated: boolean; at: string };
  /** A browser authorization URL has been prepared and its callback is being awaited. */
  authorizationPending: boolean;
  /** A refreshed grant is held in memory because the disk write failed (retrying). */
  persistencePending: boolean;
  /** An unresolved refresh exchange recorded in the grant (see `refresh_ambiguous`). */
  exchange?: { state: 'interrupted' | 'ambiguous'; since: string; tokenEndpoint: string };
}

export interface ProviderConnectionStatus {
  status: ProviderConnectionState;
  reason?: string;
  /** Present for OAuth providers whose grant needs attention. */
  oauth?: OAuthGrantHealth;
}
