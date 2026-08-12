import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { auth, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { FileOAuthProvider } from './oauth-provider.js';
import { ClientCredentialsTokenSource } from './client-credentials.js';
import type { ClientCredentialsConfig } from '../config/schema.js';
import type { ProviderConnectionStatus } from './status.js';
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
const MIN_REFRESH_TIMER_MS = 5 * 1000;
// Backoff before retrying a transiently-failed proactive refresh (network blip, 5xx).
const REFRESH_RETRY_MS = 60 * 1000;

/** Extract a short, human-readable reason from a connection error. */
function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('ENOTFOUND')) {
    const host = msg.match(/ENOTFOUND\s+(\S+)/)?.[1];
    return `DNS lookup failed for ${host ?? 'unknown host'}`;
  }
  if (msg.includes('InvalidGrantError') || err?.constructor?.name === 'InvalidGrantError') {
    return 'OAuth grant expired — re-authentication required';
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
  private client?: Client;
  private transport?: StreamableHTTPClientTransport;
  private oauthProvider?: FileOAuthProvider;
  private tokenSource?: ClientCredentialsTokenSource;
  private reconnectAttempt = 0;
  private stopped = false;
  private ready = false;
  private reconnectTimer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;
  private readyListeners = new Set<() => void>();

  private awaitingAuth = false;
  private connecting = false;
  private reconnectExhausted = false;
  private lastError?: string;
  /** Sticky until a successful reconnect; unlike awaitingAuth it survives callback/listener errors. */
  private authorizationRequired = false;

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
    private requestTimeoutMs = 60_000
  ) {
    if (this.oauth) {
      this.oauthProvider = new FileOAuthProvider(
        this.id,
        this.oauthCallbackPort,
        this.clientId,
        this.clientSecret,
        this.oauthCallbackUrl
      );
    }
    // App-identity auth. Mutually exclusive with `oauth` (the loader rejects both together), so
    // these two never fight over the Authorization header.
    if (clientCredentials) {
      this.tokenSource = new ClientCredentialsTokenSource(this.id, clientCredentials);
    }
  }

  onReady(cb: () => void): void {
    this.readyListeners.add(cb);
  }

  async connect(): Promise<void> {
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
      transportOpts.authProvider = this.oauthProvider;
    }

    if (this.tokenSource) {
      transportOpts.fetch = this.clientCredentialsFetch();
    }

    this.transport = new StreamableHTTPClientTransport(new URL(this.url), transportOpts);

    this.client = new Client({ name: 'airlock', version: VERSION });
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
        this.startOAuthFlow(true);
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

  /**
   * Run the full browser OAuth flow: wait for the user to authorize in the
   * browser, finish the auth exchange, then reconnect with fresh tokens.
   */
  private async runOAuthFlow(authorizationPrepared: boolean): Promise<void> {
    this.awaitingAuth = true;
    try {
      if (!authorizationPrepared) {
        const result = await auth(this.oauthProvider!, { serverUrl: this.url });
        if (result === 'AUTHORIZED') {
          // The reactive 401 raced a usable refresh token. Reconnect without asking the operator
          // to complete a browser flow that is no longer necessary.
          this.awaitingAuth = false;
          const oldTransport = this.transport;
          if (oldTransport) oldTransport.onclose = undefined;
          await oldTransport?.close();
          await this.connect();
          return;
        }
      }
      // Usually the callback completes this process's flow. A CLI/helper may instead finish OAuth
      // and replace the shared credential file. Notice that replacement and recover immediately;
      // previously this client waited forever until Airlock was restarted.
      while (true) {
        log.info({ id: this.id }, 'OAuth authorization required, waiting for browser flow');
        const previousTokenVersion = await this.oauthProvider!.tokenVersion();
        const tokenChangeAbort = new AbortController();
        const outcome = await Promise.race([
          this.oauthProvider!.waitForAuthCode().then((code) => ({ code })),
          this.oauthProvider!.waitForTokenChange(
            previousTokenVersion,
            tokenChangeAbort.signal
          ).then(() => ({ credentialsChanged: true as const })),
        ]);
        tokenChangeAbort.abort();

        if ('code' in outcome) {
          await this.transport!.finishAuth(outcome.code);
          break;
        }

        this.oauthProvider!.stopCallbackServer();
        const result = await auth(this.oauthProvider!, { serverUrl: this.url });
        if (result === 'AUTHORIZED') {
          const oldTransport = this.transport;
          if (oldTransport) oldTransport.onclose = undefined;
          await oldTransport?.close();
          await this.connectAfterOAuth();
          return;
        }
        // The replacement was not usable. auth() prepared a fresh authorization request; wait for
        // that callback (or another external replacement) without latching stale state.
      }
    } catch (err) {
      this.lastError = friendlyError(err);
      throw err;
    } finally {
      this.awaitingAuth = false;
    }
    // Tokens are now persisted by the provider. Reconnect with a fresh
    // transport — the old one was already started and cannot be reused.
    await this.connectAfterOAuth();
  }

  /** Reconnect while runOAuthFlow still owns the awaitingAuth latch. */
  private async connectAfterOAuth(): Promise<void> {
    this.awaitingAuth = false;
    await this.connect();
  }

  /**
   * Move the provider to an honest auth_required state and start exactly one callback listener.
   * The SDK has already generated the authorization URL/PKCE verifier by the time it surfaces an
   * UnauthorizedError (including JSON-RPC "Unauthorized" failures), so this completes that flow.
   */
  private startOAuthFlow(authorizationPrepared = false): void {
    if (!this.oauthProvider || this.stopped) return;
    this.ready = false;
    this.connecting = false;
    this.authorizationRequired = true;
    this.lastError = 'OAuth authorization required';
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.awaitingAuth) return;

    // Set this synchronously before launching the promise so concurrent failed tool calls cannot
    // race multiple callback servers onto the same provider port.
    this.awaitingAuth = true;
    void this.runOAuthFlow(authorizationPrepared).catch((oauthErr) => {
      this.lastError = friendlyError(oauthErr);
      log.error({ id: this.id, reason: this.lastError }, 'OAuth flow failed');
    });
  }

  /**
   * Schedule a proactive OAuth token refresh a little before the access token expires. Re-arms
   * itself after each refresh, and chains sub-timers for tokens whose lifetime exceeds the
   * setTimeout ceiling. No-op for non-OAuth providers or tokens without a refresh_token/expiry.
   */
  private async scheduleProactiveRefresh(): Promise<void> {
    if (!this.oauthProvider) return;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    const untilRefresh = await this.oauthProvider.msUntilRefresh(REFRESH_BUFFER_MS);
    if (untilRefresh === undefined) return;
    const beyondCeiling = untilRefresh > MAX_REFRESH_TIMER_MS;
    const delay = Math.max(Math.min(untilRefresh, MAX_REFRESH_TIMER_MS), MIN_REFRESH_TIMER_MS);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
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
   * Refresh the access token via the stored refresh_token, ahead of expiry. On success the new token
   * is persisted and picked up on the transport's next request (it reads tokens per-request), so no
   * reconnect is needed; then re-arm the schedule. If the refresh_token itself is no longer valid,
   * `auth()` returns 'REDIRECT' — interactive re-auth is required and the reactive path / manual
   * re-auth will handle it, so don't loop here.
   */
  private async proactiveRefresh(): Promise<void> {
    if (this.stopped || this.awaitingAuth || !this.oauthProvider) return;
    try {
      const result = await auth(this.oauthProvider, { serverUrl: this.url });
      if (result === 'AUTHORIZED') {
        log.info({ id: this.id }, 'Proactively refreshed OAuth token before expiry');
        await this.scheduleProactiveRefresh();
      } else {
        log.warn(
          { id: this.id },
          'Proactive token refresh needs interactive re-authorization (refresh token invalid)'
        );
        this.startOAuthFlow(true);
      }
    } catch (err) {
      log.warn(
        { id: this.id, reason: friendlyError(err) },
        'Proactive token refresh failed; retrying'
      );
      if (!this.stopped) {
        this.refreshTimer = setTimeout(() => {
          this.refreshTimer = undefined;
          void this.proactiveRefresh();
        }, REFRESH_RETRY_MS);
        this.refreshTimer.unref?.();
      }
    }
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
      return this.client.callTool(request, undefined, { timeout: this.requestTimeoutMs });
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
    if (this.ready) return { status: 'up' };
    if (this.authorizationRequired) {
      return { status: 'auth_required', reason: this.lastError ?? 'OAuth authorization required' };
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
