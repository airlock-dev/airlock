import {
  StreamableHTTPClientTransport,
  auth,
  extractWWWAuthenticateParams,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import type { AuthProvider, Tool } from '@modelcontextprotocol/client';
import {
  EventsAwareClient,
  wrapFetchWithEventHeaders,
  type UpstreamEventStreamCallbacks,
  type UpstreamEventStreamHandle,
  type UpstreamEventStreamOptions,
} from '../events/upstream-client.js';
import type {
  EventDescriptor,
  EventsPollParams,
  EventsPollResult,
  EventsStreamParams,
} from '../events/protocol.js';
import { FileOAuthProvider } from './oauth-provider.js';
import { ClientCredentialsTokenSource } from './client-credentials.js';
import type { ClientCredentialsConfig } from '../config/schema.js';
import type { OAuthGrantHealth, OAuthGrantState, ProviderConnectionStatus } from './status.js';
import type { OAuthStorageMode } from './oauth-store.js';
import {
  OAUTH_SHUTDOWN_DRAIN_MS,
  oauthFetch,
  refreshGrant,
  type RefreshOutcome,
} from './oauth-refresh.js';
import { childLogger } from '../util/logger.js';
import { VERSION } from '../version.js';

const log = childLogger('http-client');

type McpRequestMeta = Record<string, unknown>;

const BACKOFF_STEPS = [1000, 2000, 4000, 8000, 16000, 30000];
const MAX_RECONNECT_ATTEMPTS = BACKOFF_STEPS.length;

// Proactive OAuth refresh: renew the access token this long before it expires. Many OAuth servers
// report access-token expiry as an application-level error (not HTTP 401), so the SDK's reactive
// on-401 refresh never fires and the connection silently rots — refreshing ahead of time avoids it.
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
// setTimeout overflows past ~24.8 days (2^31 ms) and fires immediately, so cap each timer and
// re-evaluate — long-lived tokens (e.g. a 1-year access token) chain 24h checks until near expiry.
const MAX_REFRESH_TIMER_MS = 24 * 60 * 60 * 1000;
// Floor so a token already at/near expiry doesn't schedule a busy 0ms loop on connect.
let minRefreshTimerMs = 5 * 1000;

/** Test hook: lower the proactive-refresh timer floor (default 5 s). */
export function setProactiveRefreshFloorMs(ms = 5 * 1000): void {
  minRefreshTimerMs = ms;
}

/** A refresh outcome whose access token is usable now (persisted or still being written). */
function tokenUsable(outcome: RefreshOutcome): boolean {
  return outcome.kind === 'refreshed' || outcome.kind === 'unpersisted';
}
// Refresh retry backoff: 1m, 2m, 4m … capped at 30m, forever. Applies to transient failures and
// to issuer rejections alike — a grant is never given up on automatically.
let REFRESH_RETRY_MS = 60 * 1000;

/** Test hook: shorten the base refresh retry delay (default 60 s). */
export function setRefreshRetryBaseMs(ms = 60 * 1000): void {
  REFRESH_RETRY_MS = ms;
}
const MAX_REFRESH_RETRY_MS = 30 * 60 * 1000;
// After an ambiguous exchange (answer lost) retry the same endpoint quickly once: issuers with a
// refresh-token reuse grace window (commonly 30–60 s) then still accept the presented token.
const AMBIGUOUS_RETRY_MS = 5 * 1000;
// A reactive 401 right after a successful refresh is answered by retrying, not by refreshing again.
const RECENT_REFRESH_MS = 5 * 1000;

export interface HttpMcpClientOptions {
  /** `readonly` for CLI commands: never refresh, write, or invalidate OAuth grants. */
  oauthStorage?: OAuthStorageMode;
  /** Override `~/.airlock/oauth` (tests). */
  oauthStoreDir?: string;
  /** Refresh at least this often while a refresh token is stored (default 24 h). */
  oauthMaxRefreshIntervalMs?: number;
}

/** Extract a short, human-readable reason from a connection error. */
function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('ENOTFOUND')) {
    const host = msg.match(/ENOTFOUND\s+(\S+)/)?.[1];
    return `DNS lookup failed for ${host ?? 'unknown host'}`;
  }
  if (msg.includes('InvalidGrantError') || err?.constructor?.name === 'InvalidGrantError') {
    return 'OAuth issuer rejected the grant (invalid_grant)';
  }
  if (msg.includes('ECONNREFUSED')) return 'connection refused';
  return msg.split('\n')[0];
}

function isInvalidSessionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const normalized = msg.toLowerCase();
  return (
    normalized.includes('no valid session id provided') ||
    normalized.includes('missing session id') ||
    normalized.includes('invalid or expired session id') ||
    normalized.includes('session not found')
  );
}

function isAuthRequiredError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const normalized = msg.toLowerCase();
  return (
    err instanceof UnauthorizedError ||
    normalized.includes('unauthorized') ||
    /(^|\D)401(\D|$)/.test(normalized) ||
    normalized.includes('invalid grant') ||
    msg.includes('InvalidGrantError') ||
    (err as { constructor?: { name?: string } } | undefined)?.constructor?.name ===
      'InvalidGrantError'
  );
}

export class HttpMcpClient {
  private client?: EventsAwareClient;
  private transport?: StreamableHTTPClientTransport;
  private oauthProvider?: FileOAuthProvider;
  private tokenSource?: ClientCredentialsTokenSource;
  private reconnectAttempt = 0;
  private stopped = false;
  private ready = false;
  private reconnectTimer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;
  /** Absolute time the pending refreshTimer fires (proactive refresh or retry). */
  private refreshDeadline?: number;
  private readyListeners = new Set<() => void>();
  private eventsListChangedListeners = new Set<() => void>();

  private awaitingAuth = false;
  private connecting = false;
  private reconnectExhausted = false;
  private lastError?: string;
  /** Sticky until a successful reconnect; unlike awaitingAuth it survives callback/listener errors. */
  private authorizationRequired = false;

  // OAuth grant health (see OAuthGrantHealth). Never paged; surfaced through status and /health.
  private oauthState: OAuthGrantState = 'ok';
  private refreshFailures = 0;
  private lastRefreshError?: string;
  private lastRefreshErrorAt?: number;
  private lastRefreshAt?: number;
  private nextRefreshRetryAt?: number;
  private oauthIssuer?: string;
  private issuerChanged?: { from: string; to: string; migrated: boolean; at: number };
  private authorizationPending = false;
  private lastRecordedOutcome?: RefreshOutcome;
  private lastRecordedOutcomeAt = 0;
  /** From the latest 401 challenge: where the PRM lives and which scope the resource wants. */
  private challengeResourceMetadataUrl?: URL;
  private challengeScope?: string;
  private flowAbort?: AbortController;
  /** Wakes the auth flow's current wait so it re-evaluates (e.g. after taking the writer lock). */
  private flowWake?: () => void;
  private unsubscribeWriterAcquired?: () => void;
  private maintenanceArming = false;
  private readonly oauthMaxRefreshIntervalMs?: number;
  /** Consecutive ambiguous refresh failures (drives the one quick retry). */
  private ambiguousFailures = 0;

  constructor(
    private id: string,
    private url: string,
    private headers?: Record<string, string>,
    private oauth = false,
    private oauthCallbackPort = 18432,
    private clientId?: string,
    private clientSecret?: string,
    private oauthCallbackUrl?: string,
    clientCredentials?: ClientCredentialsConfig,
    private requestTimeoutMs = 60_000,
    options: HttpMcpClientOptions = {}
  ) {
    if (this.oauth) {
      this.oauthProvider = new FileOAuthProvider(
        this.id,
        this.oauthCallbackPort,
        this.clientId,
        this.clientSecret,
        this.oauthCallbackUrl,
        { storage: options.oauthStorage ?? 'writer', storeDir: options.oauthStoreDir }
      );
    }
    this.oauthMaxRefreshIntervalMs = options.oauthMaxRefreshIntervalMs;
    // App-identity auth. Mutually exclusive with `oauth` (the loader rejects both together), so
    // these two never fight over the Authorization header.
    if (clientCredentials) {
      this.tokenSource = new ClientCredentialsTokenSource(this.id, clientCredentials);
    }
  }

  onReady(cb: () => void): void {
    this.readyListeners.add(cb);
  }

  onEventsListChanged(cb: () => void): void {
    this.eventsListChangedListeners.add(cb);
  }

  async connect(): Promise<void> {
    // Grant maintenance does not depend on the MCP endpoint: a down resource server must never let
    // the refresh token reach its inactivity limit.
    this.ensureGrantMaintenance();
    // Don't reconnect while waiting for the user to complete the browser OAuth flow
    if (this.awaitingAuth) {
      log.debug({ id: this.id }, 'Skipping connect — already awaiting OAuth');
      return;
    }

    // Cancel any pending reconnect timer to prevent concurrent connect() calls.
    // This matters when connectInBackground() calls connect() immediately while a
    // timer from a previous onclose is still pending — without this, both would run
    // concurrently and the timer's connect() would overwrite this.client/transport
    // mid-flight, causing listTools() to use a client with no session ID yet.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    const transportOpts: ConstructorParameters<typeof StreamableHTTPClientTransport>[1] = {};

    if (this.headers) {
      transportOpts.requestInit = { headers: this.headers };
    }

    if (this.oauthProvider) {
      // A minimal AuthProvider, deliberately NOT the OAuthClientProvider: handing the transport the
      // full provider makes it run the SDK's auth() on every 401, which refreshes on its own terms
      // and deletes credentials on invalid_grant / issuer mismatch. Airlock owns refresh instead.
      transportOpts.authProvider = this.oauthAuthProvider();
    }

    if (this.tokenSource) {
      transportOpts.fetch = wrapFetchWithEventHeaders(this.clientCredentialsFetch());
    } else {
      transportOpts.fetch = wrapFetchWithEventHeaders();
    }

    this.transport = new StreamableHTTPClientTransport(new URL(this.url), transportOpts);

    // Probe with server/discover and speak 2026-07-28 (stateless) to upstreams that support it;
    // anything else falls back to the 2025 initialize handshake, unchanged from before.
    this.client = new EventsAwareClient(
      { name: 'airlock', version: VERSION },
      { versionNegotiation: { mode: 'auto' } }
    );
    this.client.onEventsListChanged?.(() => {
      for (const cb of this.eventsListChangedListeners) cb();
    });
    this.connecting = true;

    this.transport.onclose = () => {
      this.ready = false;
      this.connecting = false;
      this.lastError ??= 'connection closed';
      if (!this.stopped && !this.awaitingAuth) {
        const delay = BACKOFF_STEPS[Math.min(this.reconnectAttempt, BACKOFF_STEPS.length - 1)];
        // Never stop retrying. A provider that recovers on its own (server restarted, network
        // healed) must be picked back up without a gateway restart — previously we gave up after
        // MAX_RECONNECT_ATTEMPTS and the provider stayed dead until someone noticed and restarted
        // Airlock. Past that threshold we keep retrying at the capped interval, but report the
        // provider as `down` rather than `connecting`, so status stays honest about a long outage.
        if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
          if (!this.reconnectExhausted) {
            this.reconnectExhausted = true;
            log.error(
              { id: this.id, retryInterval: delay },
              'HTTP MCP still down after %d attempts — retrying in background',
              MAX_RECONNECT_ATTEMPTS
            );
          } else {
            // Already reported down; keep the ongoing retries at debug so a provider that is
            // out for hours doesn't flood the log every 30s.
            log.debug({ id: this.id, delay }, 'HTTP MCP still down, retrying');
          }
        } else {
          log.warn(
            { id: this.id, attempt: this.reconnectAttempt, delay },
            'HTTP MCP disconnected, reconnecting'
          );
        }
        this.reconnectAttempt++;
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = undefined;
          void this.connect().catch((err) =>
            log.error({ id: this.id, reason: friendlyError(err) }, 'HTTP MCP reconnect failed')
          );
        }, delay);
      }
    };

    try {
      await this.client.connect(this.transport);
      this.reconnectAttempt = 0;
      // Cleared only on a SUCCESSFUL connect, not per attempt: while retries are in flight after
      // the fast attempts are spent, the provider genuinely is down and status must say so.
      this.reconnectExhausted = false;
      this.ready = true;
      this.connecting = false;
      this.authorizationRequired = false;
      this.lastError = undefined;
      log.info({ id: this.id, url: this.url }, 'MCP HTTP client connected');
      // Best-effort: a failure to arm the refresh timer must never break the connection.
      void this.scheduleProactiveRefresh().catch((err) =>
        log.debug({ id: this.id, reason: friendlyError(err) }, 'Failed to schedule token refresh')
      );
      this.notifyReady();
    } catch (err) {
      this.ready = false;
      this.connecting = false;
      this.lastError = friendlyError(err);
      if (isAuthRequiredError(err) && this.oauthProvider) {
        this.startOAuthFlow();
        return;
      }
      log.error({ id: this.id, reason: friendlyError(err) }, 'MCP HTTP connect failed');
      throw err;
    }
  }

  /**
   * A `fetch` that stamps every request with the app's client-credentials token, minting it on
   * first use and re-minting when it expires.
   *
   * This deliberately bypasses the SDK's own `auth()` machinery: that path assumes an authorization
   * -code flow and would try to open a browser on a 401 — meaningless for an identity with no user
   * behind it. Injecting at the transport's fetch seam keeps the whole grant self-contained.
   *
   * A 401 gets ONE forced re-mint and retry: expiry is not the only way these tokens die (rotating
   * the client secret revokes every live token at once), and the alternative is a provider that
   * stays dead until someone restarts the gateway.
   */
  private clientCredentialsFetch(): (url: string | URL, init?: RequestInit) => Promise<Response> {
    const source = this.tokenSource!;
    return async (url, init) => {
      const send = async (force: boolean): Promise<Response> => {
        const token = await source.getToken(force);
        const headers = new Headers(init?.headers);
        headers.set('Authorization', `Bearer ${token}`);
        return fetch(url, { ...init, headers });
      };

      const res = await send(false);
      if (res.status !== 401) return res;

      // A streaming body can't be replayed, so a retry would send an empty request. MCP sends JSON
      // strings, so this is the theoretical case — but silently sending a bodiless retry would be
      // a nightmare to debug, so hand back the 401 and let the normal error path report it.
      if (init?.body instanceof ReadableStream) return res;

      await res.body?.cancel().catch(() => {});
      log.info({ id: this.id }, 'Provider rejected client-credentials token — re-minting');
      return send(true);
    };
  }

  /** The transport's view of OAuth: current access token, and Airlock-owned refresh on 401. */
  private oauthAuthProvider(): AuthProvider {
    const provider = this.oauthProvider!;
    return {
      token: async () => (await provider.tokens())?.access_token,
      onUnauthorized: async (ctx) => {
        const challenge = extractWWWAuthenticateParams(ctx.response);
        if (challenge.resourceMetadataUrl) {
          this.challengeResourceMetadataUrl = challenge.resourceMetadataUrl;
        }
        if (challenge.scope) this.challengeScope = challenge.scope;
        // Another trigger refreshed moments ago: let the transport retry with the new token.
        if (this.lastRefreshAt && Date.now() - this.lastRefreshAt < RECENT_REFRESH_MS) return;
        const outcome = await this.refreshNow('reactive');
        if (!tokenUsable(outcome)) {
          if (outcome.kind === 'rejected' || outcome.kind === 'failed') this.scheduleRefreshRetry();
          throw new UnauthorizedError(this.outcomeReason(outcome));
        }
      },
    };
  }

  /** Refresh the stored grant (single-flight per token file) and record the outcome. */
  private async refreshNow(trigger: string): Promise<RefreshOutcome> {
    const outcome = await refreshGrant(this.oauthProvider!, this.url, {
      resourceMetadataUrl: this.challengeResourceMetadataUrl,
    });
    this.recordRefreshOutcome(outcome, trigger);
    return outcome;
  }

  private recordRefreshOutcome(outcome: RefreshOutcome, trigger: string): void {
    // Single-flight: concurrent triggers receive the same outcome object; count it once.
    if (outcome === this.lastRecordedOutcome) return;
    const now = Date.now();
    this.lastRecordedOutcome = outcome;
    this.lastRecordedOutcomeAt = now;
    if ('issuerChange' in outcome && outcome.issuerChange) {
      this.issuerChanged = {
        ...outcome.issuerChange,
        migrated: tokenUsable(outcome) && 'migrated' in outcome && outcome.migrated === true,
        at: now,
      };
    }
    if (outcome.kind !== 'failed' || !outcome.ambiguous) this.ambiguousFailures = 0;
    switch (outcome.kind) {
      case 'refreshed':
        this.refreshFailures = 0;
        this.nextRefreshRetryAt = undefined;
        this.lastRefreshAt = now;
        this.oauthIssuer = outcome.issuer ?? this.oauthIssuer;
        this.oauthState = 'ok';
        this.lastRefreshError = undefined;
        this.lastRefreshErrorAt = undefined;
        log.info(
          { id: this.id, trigger, issuer: outcome.issuer, persistence: outcome.persistence },
          'Refreshed OAuth access token'
        );
        this.rearmAfterExchange();
        return;
      case 'unpersisted':
        // Usable from memory, not on disk: persistence_pending (reported live from the provider).
        this.refreshFailures = 0;
        this.nextRefreshRetryAt = undefined;
        this.lastRefreshAt = now;
        this.oauthIssuer = outcome.issuer ?? this.oauthIssuer;
        this.oauthState = 'ok';
        this.lastRefreshError = outcome.message;
        this.lastRefreshErrorAt = now;
        log.warn({ id: this.id, trigger, issuer: outcome.issuer }, outcome.message);
        this.rearmAfterExchange();
        return;
      case 'rejected':
        this.oauthState = 'grant_rejected';
        this.refreshFailures++;
        this.lastRefreshError =
          outcome.code === 'endpoint_retired'
            ? `endpoint_retired: ${outcome.message} (the grant stays pinned to that endpoint until a refresh there succeeds, or a new authorization or restore replaces it)`
            : outcome.afterAmbiguous
              ? `issuer rejected the stored refresh grant after an earlier exchange whose answer was lost; that exchange probably consumed it, so browser re-authorization is likely required (${outcome.message})`
              : `issuer rejected the stored refresh grant (${outcome.message})`;
        this.lastRefreshErrorAt = now;
        this.oauthIssuer = outcome.issuer ?? this.oauthIssuer;
        log.warn(
          {
            id: this.id,
            trigger,
            code: outcome.code,
            issuer: outcome.issuer,
            consecutiveFailures: this.refreshFailures,
            issuerChanged: outcome.issuerChange,
          },
          'OAuth issuer rejected the stored refresh grant; grant kept on disk, refresh will be retried with backoff'
        );
        return;
      case 'failed':
        this.oauthState = outcome.ambiguous ? 'refresh_ambiguous' : 'refresh_failing';
        this.refreshFailures++;
        if (outcome.ambiguous) this.ambiguousFailures++;
        this.lastRefreshError = outcome.ambiguous
          ? `refresh answer lost; the issuer may have rotated the refresh token (${outcome.message})`
          : outcome.message;
        this.lastRefreshErrorAt = now;
        log.warn(
          {
            id: this.id,
            trigger,
            reason: outcome.message,
            issuer: outcome.issuer,
            consecutiveFailures: this.refreshFailures,
          },
          'OAuth token refresh failed; stored grant kept, retrying with backoff'
        );
        return;
      case 'no_grant':
        this.oauthState = 'missing';
        return;
      case 'read_only':
        this.oauthState = 'read_only';
        this.lastRefreshError = outcome.reason;
        log.debug({ id: this.id, trigger, reason: outcome.reason }, 'Not refreshing OAuth token');
        return;
    }
  }

  /**
   * Every successful exchange — proactive, reactive (401) or auth-flow — recomputes the proactive
   * deadline from the new token's lifetime (recordRefreshOutcome runs once per exchange).
   */
  private rearmAfterExchange(): void {
    if (this.stopped || !this.oauthProvider || this.oauthProvider.storageMode !== 'writer') return;
    void this.scheduleProactiveRefresh({ reset: true }).catch((err) =>
      log.debug({ id: this.id, reason: friendlyError(err) }, 'Failed to re-arm token refresh')
    );
  }

  private outcomeReason(outcome: RefreshOutcome): string {
    switch (outcome.kind) {
      case 'refreshed':
        return 'OAuth token refreshed';
      case 'unpersisted':
        return `OAuth token refreshed but not yet written to disk (${outcome.message})`;
      case 'rejected':
        return `OAuth issuer rejected the stored grant (${outcome.message}); grant kept, refresh retrying with backoff, browser re-authorization available`;
      case 'failed':
        return outcome.ambiguous
          ? `OAuth token refresh answer lost (${outcome.message}); the issuer may have rotated the refresh token; retrying the same endpoint`
          : `OAuth token refresh failing (${outcome.message}); grant kept, retrying with backoff`;
      case 'no_grant':
        return 'OAuth authorization required';
      case 'read_only':
        return `OAuth access token not usable and this process does not refresh it (${outcome.reason})`;
    }
  }

  private refreshBackoffMs(): number {
    const exponent = Math.max(0, this.refreshFailures - 1);
    return Math.min(REFRESH_RETRY_MS * 2 ** Math.min(exponent, 16), MAX_REFRESH_RETRY_MS);
  }

  /** Retry the refresh later. Never gives up; the delay grows to 30 minutes. */
  private scheduleRefreshRetry(
    delay = this.ambiguousFailures === 1 ? AMBIGUOUS_RETRY_MS : this.refreshBackoffMs()
  ): void {
    if (this.stopped || !this.oauthProvider) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.nextRefreshRetryAt = Date.now() + delay;
    this.refreshDeadline = this.nextRefreshRetryAt;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refreshDeadline = undefined;
      this.nextRefreshRetryAt = undefined;
      void this.proactiveRefresh();
    }, delay);
    this.refreshTimer.unref?.();
  }

  /**
   * Interactive-authorization fallback. Runs while the provider is unusable:
   *  1. try a refresh of the stored grant (a 401 often races a refresh that would succeed);
   *  2. prepare a browser authorization — staged as `pending`, never touching the stored grant;
   *  3. wait for the callback code, or for the token file to change (our own background refresh
   *     retry succeeding, another process, or an operator restore) — whichever comes first.
   * Then reconnect. Background refresh retries keep running throughout.
   */
  private async runOAuthFlow(): Promise<void> {
    const provider = this.oauthProvider!;
    const abort = new AbortController();
    this.flowAbort = abort;
    try {
      let first = true;
      while (!this.stopped && !abort.signal.aborted) {
        // The 401 that started this flow usually just ran a refresh; don't hit the issuer twice.
        const recent =
          first &&
          this.lastRecordedOutcome &&
          Date.now() - this.lastRecordedOutcomeAt < RECENT_REFRESH_MS
            ? this.lastRecordedOutcome
            : undefined;
        first = false;
        // A just-refreshed token that the server still answers with 401 is not fixed by another
        // refresh (that would loop, spending a rotating token each time). Back off instead.
        const freshTokenRejected = recent !== undefined && tokenUsable(recent);
        const outcome = recent ?? (await this.refreshNow('auth-required'));
        if (tokenUsable(outcome) && !freshTokenRejected) break;
        if (outcome.kind === 'rejected' || outcome.kind === 'failed') {
          if (!this.refreshTimer) this.scheduleRefreshRetry();
        }
        if (
          outcome.kind === 'read_only' &&
          provider.storageMode === 'writer' &&
          !this.refreshTimer
        ) {
          // Another Airlock process owns the store; check again later in case it goes away.
          this.scheduleRefreshRetry(REFRESH_RETRY_MS);
        }
        this.lastError = freshTokenRejected
          ? 'MCP server rejected a freshly refreshed OAuth token'
          : this.outcomeReason(outcome);

        let prepared = false;
        if (outcome.kind !== 'read_only') {
          try {
            const result = await this.prepareAuthorization();
            if (result === 'AUTHORIZED') break; // non-interactive grant obtained; just reconnect
            prepared = true;
          } catch (err) {
            log.warn(
              { id: this.id, reason: friendlyError(err) },
              'Could not prepare browser OAuth authorization; will retry'
            );
          }
        }
        this.authorizationPending = prepared;
        if (prepared) {
          log.info({ id: this.id }, 'OAuth authorization required, waiting for browser flow');
        }

        const previousTokenVersion = await provider.tokenVersion();
        const waitAbort = new AbortController();
        const onFlowAbort = () => waitAbort.abort();
        abort.signal.addEventListener('abort', onFlowAbort, { once: true });
        type Waited = { code: string } | { credentialsChanged: true } | { retry: true };
        const waits: Promise<Waited>[] = [
          // Re-evaluate at once when something changes what this flow can do (this process just
          // took the writer lock, a background refresh found no grant to refresh).
          new Promise<Waited>((resolve) => {
            this.flowWake = () => resolve({ retry: true });
          }),
          provider
            .waitForTokenChange(previousTokenVersion, waitAbort.signal)
            .then(() => ({ credentialsChanged: true as const })),
        ];
        if (prepared) {
          waits.push(
            provider.waitForAuthCode().then(
              (code) => ({ code }),
              (err: unknown) => {
                log.warn(
                  { id: this.id, reason: friendlyError(err) },
                  'OAuth callback failed; preparing a new authorization later'
                );
                return sleep(this.refreshBackoffMs(), waitAbort.signal).then(() => ({
                  retry: true as const,
                }));
              }
            )
          );
        } else {
          // Never wait unboundedly: a read-only wait (another process owns the store) is
          // re-evaluated at least every minute, and at once when this process takes the lock.
          const delay = outcome.kind === 'read_only' ? REFRESH_RETRY_MS : this.refreshBackoffMs();
          waits.push(sleep(delay, waitAbort.signal).then(() => ({ retry: true as const })));
        }
        const result = await Promise.race(waits);
        this.flowWake = undefined;
        waitAbort.abort();
        abort.signal.removeEventListener('abort', onFlowAbort);
        if (this.stopped || abort.signal.aborted) return;

        if ('code' in result) {
          try {
            await this.finishAuthorization(result.code);
            break;
          } catch (err) {
            this.lastError = friendlyError(err);
            log.warn(
              { id: this.id, reason: this.lastError },
              'OAuth authorization code exchange failed; stored grant kept'
            );
            continue;
          }
        }
        provider.stopCallbackServer();
        if ('credentialsChanged' in result) {
          log.info({ id: this.id }, 'OAuth credentials changed on disk; reconnecting');
          break;
        }
        // retry: loop again (refresh + re-prepare)
      }
    } catch (err) {
      this.lastError = friendlyError(err);
      throw err;
    } finally {
      this.awaitingAuth = false;
      this.authorizationPending = false;
      provider.stopCallbackServer();
      if (this.flowAbort === abort) this.flowAbort = undefined;
    }
    if (this.stopped || abort.signal.aborted) return;
    // Credentials are persisted. Reconnect with a fresh transport — the old one was already
    // started and cannot be reused.
    this.client?.closeEventStreams?.('events/stream: upstream reconnecting after OAuth');
    const oldTransport = this.transport;
    if (oldTransport) oldTransport.onclose = undefined;
    await oldTransport?.close();
    await this.connect();
  }

  /** Stage a new browser authorization. The stored grant stays usable for refresh meanwhile. */
  private async prepareAuthorization(): Promise<'AUTHORIZED' | 'REDIRECT'> {
    const provider = this.oauthProvider!;
    await provider.beginAuthorization();
    const result = await auth(provider, {
      serverUrl: this.url,
      forceReauthorization: true,
      fetchFn: oauthFetch,
      ...(this.challengeResourceMetadataUrl
        ? { resourceMetadataUrl: this.challengeResourceMetadataUrl }
        : {}),
      ...(this.challengeScope ? { scope: this.challengeScope } : {}),
    });
    return result;
  }

  /** Exchange the callback code; on success the provider commits the new grant. */
  private async finishAuthorization(code: string): Promise<void> {
    const provider = this.oauthProvider!;
    if (this.stopped || provider.closing) throw new Error('Airlock is shutting down');
    // Serialized with refresh exchanges of the same grant: a refresh in flight finishes (and
    // commits coherently) before the new grant replaces it, never after.
    // Checked again at dispatch: a code exchange queued behind a refresh must not be sent once
    // shutdown has begun (its result could not be committed before exit).
    const fetchFn: typeof fetch = (input, init) => {
      if (provider.closing && (init?.method ?? 'GET').toUpperCase() === 'POST') {
        return Promise.reject(new Error('Airlock is shutting down; OAuth request not sent'));
      }
      return oauthFetch(input as string | URL, init);
    };
    const result = await provider.runExclusive(() =>
      auth(provider, {
        serverUrl: this.url,
        authorizationCode: code,
        fetchFn,
        ...(this.challengeResourceMetadataUrl
          ? { resourceMetadataUrl: this.challengeResourceMetadataUrl }
          : {}),
        ...(this.challengeScope ? { scope: this.challengeScope } : {}),
      })
    );
    if (result !== 'AUTHORIZED') throw new UnauthorizedError('Failed to authorize');
    this.oauthState = 'ok';
    this.refreshFailures = 0;
    this.lastRefreshError = undefined;
    this.lastRefreshErrorAt = undefined;
    this.issuerChanged = undefined;
    this.lastRefreshAt = Date.now();
    log.info({ id: this.id }, 'OAuth authorization completed');
  }

  /**
   * Move the provider to an honest auth_required state and start exactly one authorization flow.
   * Refresh retries already scheduled keep running: they may recover the stored grant on their own.
   */
  private startOAuthFlow(): void {
    if (!this.oauthProvider || this.stopped) return;
    this.ready = false;
    this.connecting = false;
    this.authorizationRequired = true;
    const recent =
      this.lastRecordedOutcome && Date.now() - this.lastRecordedOutcomeAt < RECENT_REFRESH_MS
        ? this.lastRecordedOutcome
        : undefined;
    this.lastError =
      recent && !tokenUsable(recent) ? this.outcomeReason(recent) : 'OAuth authorization required';
    this.client?.closeEventStreams?.('events/stream: upstream OAuth authorization required');
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.awaitingAuth) return;

    // Set this synchronously before launching the promise so concurrent failed tool calls cannot
    // race multiple callback servers onto the same provider port.
    this.awaitingAuth = true;
    void this.runOAuthFlow().catch((oauthErr) => {
      this.lastError = friendlyError(oauthErr);
      log.error({ id: this.id, reason: this.lastError }, 'OAuth flow failed');
    });
  }

  /**
   * Schedule a proactive OAuth token refresh a little before the access token expires. Re-arms
   * itself after each refresh, and chains sub-timers for tokens whose lifetime exceeds the
   * setTimeout ceiling. No-op for non-OAuth providers or tokens without a refresh_token/expiry.
   */
  private async scheduleProactiveRefresh(opts: { reset?: boolean } = {}): Promise<void> {
    if (!this.oauthProvider) return;
    // Unless a refresh just completed (`reset`), never push a pending deadline later: a reconnect
    // or a re-arm may only bring the next refresh (or retry) forward.
    const pending = () =>
      !opts.reset && this.refreshTimer !== undefined && this.refreshDeadline !== undefined;
    if (this.refreshFailures > 0) {
      // Already failing: keep the backoff deadline instead of hammering (or postponing).
      if (pending()) return;
      this.scheduleRefreshRetry();
      return;
    }
    const untilRefresh = await this.oauthProvider.msUntilRefresh(
      REFRESH_BUFFER_MS,
      this.oauthMaxRefreshIntervalMs
    );
    // stop() may have run while the grant was being read; never arm a timer after shutdown.
    if (this.stopped) return;
    if (untilRefresh === undefined) return;
    const beyondCeiling = untilRefresh > MAX_REFRESH_TIMER_MS;
    const delay = Math.max(Math.min(untilRefresh, MAX_REFRESH_TIMER_MS), minRefreshTimerMs);
    if (pending() && Date.now() + delay >= this.refreshDeadline!) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshDeadline = Date.now() + delay;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refreshDeadline = undefined;
      // Still far from expiry — just re-evaluate rather than refreshing early.
      if (beyondCeiling) {
        void this.scheduleProactiveRefresh().catch((err) =>
          log.debug({ id: this.id, reason: friendlyError(err) }, 'Failed to re-arm token refresh')
        );
        return;
      }
      void this.proactiveRefresh();
    }, delay);
    // Let the event loop exit even if a refresh is pending (matches setTimeout's usual test/CLI use).
    this.refreshTimer.unref?.();
  }

  /**
   * Refresh the access token via the stored refresh_token, ahead of expiry (many OAuth servers
   * signal expiry with an application-level error rather than HTTP 401, so a reactive refresh
   * would never fire). Also the retry path for failed refreshes. Never discards the grant: an
   * issuer rejection is retried with backoff exactly like an outage.
   */
  private async proactiveRefresh(): Promise<void> {
    if (this.stopped || !this.oauthProvider) return;
    let outcome: RefreshOutcome;
    try {
      outcome = await this.refreshNow('proactive');
    } catch (err) {
      // Defensive: refreshGrant reports failures as outcomes, but never let a bug stop retries.
      outcome = { kind: 'failed', message: friendlyError(err) };
      this.recordRefreshOutcome(outcome, 'proactive');
    }
    if (this.stopped) return;
    switch (outcome.kind) {
      case 'refreshed':
      case 'unpersisted':
        if (!this.ready && !this.awaitingAuth && !this.connecting) {
          // A reactive auth failure may have suspended the connection before the issuer recovered.
          const oldTransport = this.transport;
          if (oldTransport) oldTransport.onclose = undefined;
          await oldTransport?.close().catch(() => {});
          await this.connect().catch((err) =>
            log.warn({ id: this.id, reason: friendlyError(err) }, 'Reconnect after refresh failed')
          );
        }
        // Re-arm whatever the reconnect did: maintenance must never depend on the MCP endpoint.
        if (!this.stopped) await this.scheduleProactiveRefresh({ reset: true });
        return;
      case 'rejected':
      case 'failed':
        this.scheduleRefreshRetry();
        return;
      case 'read_only':
        if (this.oauthProvider.storageMode === 'writer')
          this.scheduleRefreshRetry(REFRESH_RETRY_MS);
        return;
      case 'no_grant':
        if (!this.ready && !this.awaitingAuth) this.startOAuthFlow();
        else this.flowWake?.(); // a waiting flow re-evaluates and prepares authorization
        return;
    }
  }

  /**
   * Arm grant maintenance (proactive refresh / retries) for a writer-capable OAuth provider,
   * independent of MCP connectivity, and re-evaluate a waiting auth flow whenever this process
   * acquires the OAuth writer lock.
   */
  private ensureGrantMaintenance(): void {
    const provider = this.oauthProvider;
    if (!provider || provider.storageMode !== 'writer' || this.stopped) return;
    if (!this.unsubscribeWriterAcquired) {
      this.unsubscribeWriterAcquired = provider.onWriterAcquired?.(() => {
        if (this.stopped) return;
        this.flowWake?.();
        if (!this.refreshTimer) void this.scheduleProactiveRefresh().catch(() => {});
      });
    }
    if (!this.refreshTimer && !this.maintenanceArming) {
      this.maintenanceArming = true;
      void this.scheduleProactiveRefresh()
        .catch((err) =>
          log.debug({ id: this.id, reason: friendlyError(err) }, 'Failed to schedule token refresh')
        )
        .finally(() => {
          this.maintenanceArming = false;
        });
    }
  }

  /** OAuth grant health for status and /health; undefined for non-OAuth providers. */
  getOAuthHealth(): OAuthGrantHealth | undefined {
    if (!this.oauthProvider) return undefined;
    const iso = (ms?: number) => (ms ? new Date(ms).toISOString() : undefined);
    const provider = this.oauthProvider;
    const persistencePending = provider.persistencePending === true;
    const marker = provider.exchangeMarker;
    let state = this.oauthState;
    if (persistencePending) state = 'persistence_pending';
    else if (marker && state === 'ok') state = 'refresh_ambiguous';
    return {
      state,
      storage: this.oauthProvider.storageMode,
      consecutiveFailures: this.refreshFailures,
      ...(this.lastRefreshError ? { lastError: this.lastRefreshError } : {}),
      ...(this.lastRefreshErrorAt ? { lastErrorAt: iso(this.lastRefreshErrorAt) } : {}),
      ...(this.lastRefreshAt ? { lastRefreshAt: iso(this.lastRefreshAt) } : {}),
      ...(this.nextRefreshRetryAt ? { nextRetryAt: iso(this.nextRefreshRetryAt) } : {}),
      ...(this.oauthIssuer ? { issuer: this.oauthIssuer } : {}),
      ...(this.issuerChanged
        ? { issuerChanged: { ...this.issuerChanged, at: iso(this.issuerChanged.at)! } }
        : {}),
      authorizationPending: this.authorizationPending,
      persistencePending,
      ...(marker
        ? {
            exchange: {
              state:
                marker.state === 'in_flight' ? ('interrupted' as const) : ('ambiguous' as const),
              since: iso(marker.at ?? marker.startedAt)!,
              tokenEndpoint: marker.tokenEndpoint,
            },
          }
        : {}),
    };
  }

  /** Only grant states that need attention are attached to connection status. */
  private oauthStatusDetail(): { oauth?: OAuthGrantHealth } {
    const health = this.getOAuthHealth();
    if (!health) return {};
    const notable =
      (health.state !== 'ok' && health.state !== 'missing') ||
      health.issuerChanged !== undefined ||
      health.exchange !== undefined;
    return notable ? { oauth: health } : {};
  }

  async listTools(): Promise<Tool[]> {
    return this.withSessionRetry('listTools', async () => {
      if (!this.client || !this.ready) throw new Error(`MCP ${this.id} not connected`);
      const result = await this.client.listTools(undefined, { timeout: this.requestTimeoutMs });
      return result.tools;
    });
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    requestMeta?: McpRequestMeta
  ): Promise<unknown> {
    return this.withSessionRetry('callTool', async () => {
      if (!this.client || !this.ready) throw new Error(`MCP ${this.id} not connected`);
      const request = requestMeta
        ? { name, arguments: args, _meta: requestMeta }
        : { name, arguments: args };
      return this.client.callTool(request, { timeout: this.requestTimeoutMs });
    });
  }

  supportsEvents(): boolean {
    return Boolean(this.client && this.ready && this.client.supportsEvents());
  }

  async listEvents(): Promise<EventDescriptor[]> {
    return this.withSessionRetry('listEvents', async () => {
      if (!this.client || !this.ready) throw new Error(`MCP ${this.id} not connected`);
      return this.client.listEvents({ timeout: this.requestTimeoutMs });
    });
  }

  async pollEvents(
    params: EventsPollParams,
    options?: { inputSchema?: Record<string, unknown>; signal?: AbortSignal }
  ): Promise<EventsPollResult> {
    return this.withSessionRetry('pollEvents', async () => {
      if (!this.client || !this.ready) throw new Error(`MCP ${this.id} not connected`);
      return this.client.pollEvents(params, {
        timeout: this.requestTimeoutMs,
        signal: options?.signal,
        inputSchema: options?.inputSchema,
      });
    });
  }

  async openEventStream(
    params: EventsStreamParams,
    callbacks: UpstreamEventStreamCallbacks,
    options?: UpstreamEventStreamOptions
  ): Promise<UpstreamEventStreamHandle> {
    return this.withSessionRetry('openEventStream', async () => {
      if (!this.client || !this.ready) throw new Error(`MCP ${this.id} not connected`);
      return this.client.openEventStream(params, callbacks, {
        ackTimeoutMs: this.requestTimeoutMs,
        ...options,
      });
    });
  }

  getServerInfo(): { name: string; version: string } | undefined {
    return this.client?.getServerVersion();
  }

  /** Server-level usage notes advertised at initialize (MCP `instructions`). */
  getInstructions(): string | undefined {
    return this.client?.getInstructions();
  }

  isReady(): boolean {
    return this.ready;
  }

  getConnectionStatus(): ProviderConnectionStatus {
    if (this.ready) return { status: 'up', ...this.oauthStatusDetail() };
    if (this.authorizationRequired) {
      return {
        status: 'auth_required',
        reason: this.lastError ?? 'OAuth authorization required',
        ...this.oauthStatusDetail(),
      };
    }
    // A rejected client secret is a credential problem, not an outage — say so, or it hides among
    // the reconnect noise below and reads as "the provider is down".
    const mintFailure = this.tokenSource?.lastAuthFailure;
    if (mintFailure) return { status: 'auth_required', reason: mintFailure };
    // Once the fast attempts are spent we retry forever in the background, so a pending
    // reconnectTimer is no longer evidence of a transient blip — it is the steady state of an
    // outage. Report `down` in that case, or a long-dead provider would masquerade as
    // `connecting` indefinitely.
    if (
      !this.reconnectExhausted &&
      (this.connecting || this.reconnectTimer || (!this.stopped && this.reconnectAttempt > 0))
    ) {
      return { status: 'connecting', ...(this.lastError ? { reason: this.lastError } : {}) };
    }
    return { status: 'down', ...(this.lastError ? { reason: this.lastError } : {}) };
  }

  private notifyReady(): void {
    for (const cb of this.readyListeners) {
      cb();
    }
  }

  private async withSessionRetry<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (this.oauthProvider && isAuthRequiredError(err)) {
        this.startOAuthFlow();
        throw err;
      }
      if (!isInvalidSessionError(err)) throw err;
      log.warn(
        { id: this.id, operation, reason: friendlyError(err) },
        'HTTP MCP session invalid, reconnecting'
      );
      this.ready = false;
      this.client?.closeEventStreams?.('events/stream: upstream session invalid, reconnecting');
      const oldTransport = this.transport;
      if (oldTransport) oldTransport.onclose = undefined;
      await oldTransport
        ?.close()
        .catch((closeErr) =>
          log.debug({ id: this.id, reason: friendlyError(closeErr) }, 'HTTP MCP close failed')
        );
      await this.connect();
      return fn();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribeWriterAcquired?.();
    this.flowWake = undefined;
    this.flowAbort?.abort();
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    // Admit no new token exchange, and let one already sent finish its durable commit (or hand its
    // successor off) before this process gives up the writer lock and exits.
    if (this.oauthProvider?.storageMode === 'writer') {
      await this.oauthProvider.close?.(OAUTH_SHUTDOWN_DRAIN_MS);
    }
    this.client?.closeEventStreams?.('events/stream: upstream client stopped');
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.oauthProvider?.stopCallbackServer();
    // Release the session server-side before closing locally. transport.close() only tears down
    // OUR end; without the DELETE that terminateSession() sends, the server keeps the session in
    // memory forever. Servers that bound their session table then leak a slot on every gateway
    // restart and every CLI invocation, and eventually refuse all new sessions until restarted.
    // Best-effort: a server that can't be reached (or answers 405, which the SDK treats as "not
    // supported" per spec) must never block or fail shutdown.
    await this.transport?.terminateSession().catch((err) => {
      log.debug({ id: this.id, reason: friendlyError(err) }, 'HTTP MCP session terminate failed');
    });
    await this.transport?.close();
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}
