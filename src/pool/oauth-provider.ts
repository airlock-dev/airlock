import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { createServer, type Server as HttpServer } from 'http';
import type {
  OAuthClientProvider,
  OAuthClientMetadata,
  OAuthClientInformationFull,
  OAuthDiscoveryState,
  OAuthTokens,
} from '@modelcontextprotocol/client';
import { childLogger } from '../util/logger.js';
import { adaptiveExpiryBuffer } from './oauth-timing.js';
import {
  OAuthGrantStore,
  grantIssuer,
  type OAuthStorageMode,
  type PersistedGrant,
} from './oauth-store.js';

const log = childLogger('oauth');
const PERSIST_RETRY_MS = 30 * 1000;
const TOKEN_CHANGE_POLL_MS = 2 * 1000;

export interface FileOAuthProviderOptions {
  /** `readonly` for CLI commands that must never refresh/write/invalidate. Default `writer`. */
  storage?: OAuthStorageMode;
  /** Override `~/.airlock/oauth` (tests). */
  storeDir?: string;
}

/** Everything the refresh engine needs, read from the stored grant. */
export interface GrantSnapshot {
  tokens?: OAuthTokens;
  clientInfo?: OAuthClientInformationFull;
  issuer?: string;
  discovery?: OAuthDiscoveryState;
  resource?: string;
  obtainedAt?: number;
}

export interface RefreshCommit {
  /** Issuer of the AS that issued these tokens. */
  issuer?: string;
  /** Discovery state that produced a successful refresh (becomes the known-good state). */
  discovery?: OAuthDiscoveryState;
  /** Resource indicator that was sent; recorded when the grant had none recorded yet. */
  resource?: string;
}

type StampedTokens = OAuthTokens & { issuer?: string };
type StampedClient = OAuthClientInformationFull & { issuer?: string };

/**
 * File-backed OAuth credential store for one provider (`~/.airlock/oauth/<server-id>.json`).
 *
 * It plays two roles:
 *
 * 1. The SDK-facing {@link OAuthClientProvider} used ONLY for interactive authorization (preparing
 *    a browser URL and exchanging the callback code). Everything an authorization attempt produces
 *    — a new client registration, PKCE verifier, discovery state, resource — is staged under
 *    `pending` and only replaces the stored grant when the code exchange succeeds. Starting a
 *    browser flow therefore never clobbers a grant that may still be refreshable.
 * 2. The grant store for Airlock's own refresh engine (`oauth-refresh.ts`), which never goes
 *    through the SDK's `auth()` and so never triggers its credential invalidation.
 *
 * Invariant: nothing in here deletes a grant. `invalidateCredentials()` only discards staged
 * pending state; an operator restore (`airlock oauth restore`) or a successful new authorization
 * are the only ways a stored grant is replaced, and every replacement is backed up first.
 */
export class FileOAuthProvider implements OAuthClientProvider {
  readonly store: OAuthGrantStore;
  private data: PersistedGrant = {};
  private callbackServer?: HttpServer;
  private authCodeResolve?: (code: string) => void;
  private browserOpenedAt = 0;
  private expectedState?: string;
  /** A rotated token that is usable in memory but could not yet be committed to disk. */
  private persistenceDirty = false;
  private persistenceRetryTimer?: NodeJS.Timeout;

  constructor(
    private serverId: string,
    private callbackPort: number,
    private preregisteredClientId?: string,
    private preregisteredClientSecret?: string,
    private relayCallbackUrl?: string,
    options: FileOAuthProviderOptions = {}
  ) {
    this.store = new OAuthGrantStore(serverId, options.storage ?? 'writer', options.storeDir);
  }

  get storageMode(): OAuthStorageMode {
    return this.store.mode;
  }

  /** Whether this process may refresh/write this grant right now (holds the writer lock). */
  canWrite(): Promise<boolean> {
    return this.store.canWrite();
  }

  get redirectUrl(): string {
    if (this.relayCallbackUrl) {
      return this.relayCallbackUrl;
    }
    return `http://127.0.0.1:${this.callbackPort}/oauth/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      client_name: `Airlock (${this.serverId})`,
      token_endpoint_auth_method: this.preregisteredClientSecret ? 'client_secret_post' : 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
  }

  private preregisteredClient(): OAuthClientInformationFull | undefined {
    if (!this.preregisteredClientId) return undefined;
    return {
      client_id: this.preregisteredClientId,
      redirect_uris: [this.redirectUrl],
      ...(this.preregisteredClientSecret && {
        client_secret: this.preregisteredClientSecret,
      }),
    };
  }

  // ─── SDK-facing (interactive authorization only) ──────────────────────────────────────────────

  async clientInformation(): Promise<OAuthClientInformationFull | undefined> {
    // Pre-registered credentials skip dynamic client registration.
    const preregistered = this.preregisteredClient();
    if (preregistered) return preregistered;
    await this.load();
    const info = this.data.pending?.clientInfo ?? this.data.clientInfo;
    if (info?.redirect_uris?.length && !info.redirect_uris.includes(this.redirectUrl)) {
      // Register a new client for the next authorization, but keep the stored registration: the
      // stored refresh token is bound to it and refresh does not involve a redirect URI.
      log.info(
        {
          serverId: this.serverId,
          redirectUrl: this.redirectUrl,
          cachedRedirectUris: info.redirect_uris,
        },
        'Cached OAuth client registration uses a different redirect URI; the next authorization registers a new client (stored grant kept)'
      );
      return undefined;
    }
    return info;
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    if (this.preregisteredClientId) return;
    await this.load();
    if (this.data.pending?.clientInfo?.client_id === info.client_id) {
      this.data.pending.clientInfo = info;
    } else if (this.data.clientInfo?.client_id === info.client_id || !this.data.tokens) {
      // Same registration (e.g. the SDK back-stamping its issuer) or no grant to protect yet.
      this.data.clientInfo = info;
    } else {
      // A new registration while a grant exists: stage it until the new authorization succeeds.
      this.data.pending = { startedAt: Date.now(), ...this.data.pending, clientInfo: info };
    }
    await this.save('client-registration');
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    await this.load();
    return this.data.tokens;
  }

  /**
   * Called by the SDK when an authorization-code exchange succeeds (or to back-stamp an issuer on
   * the stored tokens). With an authorization attempt pending this commits the new grant — the
   * only automatic way a stored grant is replaced. Without one, it behaves like a refresh commit.
   */
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.load();
    const stamped = tokens as StampedTokens;
    const current = this.data.tokens as StampedTokens | undefined;
    if (current && current.access_token === stamped.access_token) {
      // Same token; the SDK is only stamping the issuer (SEP-2352).
      if (stamped.issuer && current.issuer !== stamped.issuer) {
        this.data.tokens = { ...current, issuer: stamped.issuer } as OAuthTokens;
        this.data.issuer ??= stamped.issuer;
        await this.persistGrant('issuer-stamp');
      }
      return;
    }
    const pending = this.data.pending;
    if (pending) {
      const previous = this.data;
      const issuer = stamped.issuer ?? pending.issuer;
      let clientInfo = pending.clientInfo ?? previous.clientInfo;
      if (clientInfo && issuer && (clientInfo as StampedClient).issuer !== issuer) {
        clientInfo = { ...clientInfo, issuer } as OAuthClientInformationFull;
      }
      this.data = {
        clientInfo,
        tokens,
        obtainedAt: Date.now(),
        ...(issuer ? { issuer } : {}),
        ...(pending.discovery ? { discovery: pending.discovery } : {}),
        ...(pending.resource ? { resource: pending.resource } : {}),
      };
      log.info(
        {
          serverId: this.serverId,
          issuer,
          previousIssuer: grantIssuer(previous),
          replacedGrant: Boolean(previous.tokens),
          refreshTokenPresent: Boolean(tokens.refresh_token),
          resource: pending.resource,
        },
        'OAuth authorization completed; stored the new grant (previous grant kept in history)'
      );
      await this.persistGrant('authorization');
      return;
    }
    await this.commitRefresh(tokens, stamped.issuer ? { issuer: stamped.issuer } : {});
  }

  /**
   * The SDK calls this on invalid_grant / invalid_client / unauthorized_client. Airlock never lets
   * that delete a grant: an issuer outage, a clock problem, a second process racing a rotation, or
   * a misrouted request (wrong AS, missing `resource`) all produce those errors for grants that
   * are still good. Only staged authorization state is discarded.
   */
  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'
  ): Promise<void> {
    await this.load();
    log.warn(
      {
        serverId: this.serverId,
        scope,
        refreshTokenPresent: Boolean(this.data.tokens?.refresh_token),
      },
      'OAuth SDK requested credential invalidation; keeping the stored grant (only staged authorization state is discarded)'
    );
    const pending = this.data.pending;
    if (!pending) return;
    if (scope === 'all') delete this.data.pending;
    if (scope === 'client') delete pending.clientInfo;
    if (scope === 'verifier') delete pending.codeVerifier;
    if (scope === 'discovery') delete pending.discovery;
    if (scope === 'tokens') return;
    await this.save('authorization-reset').catch(() => {});
  }

  redirectToAuthorization(url: URL): Promise<void> {
    const now = Date.now();
    if (now - this.browserOpenedAt < 30_000) {
      log.debug({ serverId: this.serverId }, 'Skipping duplicate browser open (debounced)');
      return Promise.resolve();
    }
    this.browserOpenedAt = now;

    // When using an HTTPS relay, wrap the state parameter with the local port
    // so the relay can redirect back to localhost after the OAuth provider responds.
    const originalState = url.searchParams.get('state') ?? '';
    this.expectedState = originalState;
    if (this.relayCallbackUrl) {
      url.searchParams.set('state', `${this.callbackPort}.${originalState}`);
    }

    log.info(
      { serverId: this.serverId, url: url.toString() },
      'Opening browser for OAuth authorization'
    );
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    execFile(cmd, [url.toString()]);
    return Promise.resolve();
  }

  /** Stage the PKCE verifier for a new authorization. The stored grant is not touched. */
  async saveCodeVerifier(verifier: string): Promise<void> {
    await this.load();
    this.data.pending = { startedAt: Date.now(), ...this.data.pending, codeVerifier: verifier };
    delete this.data.codeVerifier;
    await this.save('authorization-start');
  }

  async codeVerifier(): Promise<string> {
    await this.load();
    return this.data.pending?.codeVerifier ?? this.data.codeVerifier ?? '';
  }

  /** Discovery state of the authorization attempt in progress (binds the callback leg's issuer). */
  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    await this.load();
    return this.data.pending?.discovery;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.load();
    this.data.pending = { startedAt: Date.now(), ...this.data.pending, discovery: state };
    await this.save('authorization-discovery');
  }

  async saveResourceUrl(resourceUrl: string): Promise<void> {
    await this.load();
    if (this.data.pending?.resource === resourceUrl) return;
    this.data.pending = { startedAt: Date.now(), ...this.data.pending, resource: resourceUrl };
    await this.save('authorization-resource');
  }

  async saveAuthorizationServerUrl(issuer: string): Promise<void> {
    await this.load();
    if (this.data.pending?.issuer === issuer) return;
    this.data.pending = { startedAt: Date.now(), ...this.data.pending, issuer };
    await this.save('authorization-issuer');
  }

  /** Start a fresh authorization attempt: discard stale staged state, keep the stored grant. */
  async beginAuthorization(): Promise<void> {
    await this.load();
    this.data.pending = { startedAt: Date.now() };
    delete this.data.codeVerifier;
    await this.save('authorization-start');
  }

  // ─── Refresh-engine facing ────────────────────────────────────────────────────────────────────

  async grant(): Promise<GrantSnapshot> {
    await this.load();
    return {
      tokens: this.data.tokens,
      clientInfo: this.preregisteredClient() ?? this.data.clientInfo,
      issuer: grantIssuer(this.data),
      discovery: this.data.discovery,
      resource: this.data.resource,
      obtainedAt: this.data.obtainedAt,
    };
  }

  /** Persist tokens obtained by refreshing the stored grant. */
  async commitRefresh(tokens: OAuthTokens, meta: RefreshCommit = {}): Promise<void> {
    // A fresh provider instance must load the persisted refresh token before handling a refresh
    // response that may omit it.
    await this.load();
    const previous = this.data.tokens;
    const previousObtainedAt = this.data.obtainedAt;
    const refreshTokenReturned = Boolean(tokens.refresh_token);
    const refreshTokenRotated = Boolean(
      tokens.refresh_token &&
      previous?.refresh_token &&
      tokens.refresh_token !== previous.refresh_token
    );
    // Preserve an existing refresh_token when a refresh response omits one. Many OAuth providers
    // return refresh_token only on the initial authorization; overwriting would drop it.
    if (!tokens.refresh_token && previous?.refresh_token) {
      tokens = { ...tokens, refresh_token: previous.refresh_token };
    }
    const issuer = meta.issuer ?? (previous as StampedTokens | undefined)?.issuer;
    this.data.tokens = issuer ? { ...tokens, issuer } : tokens;
    this.data.obtainedAt = Date.now();
    if (meta.issuer) {
      this.data.issuer = meta.issuer;
      const client = this.data.clientInfo as StampedClient | undefined;
      if (client && client.issuer && client.issuer !== meta.issuer) {
        this.data.clientInfo = { ...client, issuer: meta.issuer } as OAuthClientInformationFull;
      }
    }
    if (meta.discovery) this.data.discovery = meta.discovery;
    if (meta.resource && !this.data.resource) this.data.resource = meta.resource;
    await this.persistGrant('refresh', {
      refreshTokenReturned,
      refreshTokenRotated,
      accessExpiresInSec: tokens.expires_in,
      previousTokenAgeSec: previousObtainedAt
        ? Math.floor((this.data.obtainedAt - previousObtainedAt) / 1000)
        : undefined,
    });
  }

  /**
   * How long (ms) until the access token should be proactively refreshed — i.e. `bufferMs` before it
   * expires. Returns `undefined` when there is nothing to schedule (no refresh_token, so a refresh is
   * impossible, or no `expires_in`, so the lifetime is unknown). Never negative. Tokens persisted
   * before `obtainedAt` existed report `0` (refresh promptly) rather than trusting a stale baseline.
   */
  async msUntilRefresh(bufferMs: number): Promise<number | undefined> {
    await this.load();
    const tokens = this.data.tokens;
    if (!tokens?.refresh_token || !tokens.expires_in) return undefined;
    const obtainedAt = this.data.obtainedAt ?? 0;
    const lifetimeMs = tokens.expires_in * 1000;
    const expiresAt = obtainedAt + lifetimeMs;
    const effectiveBufferMs = adaptiveExpiryBuffer(lifetimeMs, bufferMs);
    return Math.max(0, expiresAt - effectiveBufferMs - Date.now());
  }

  /** Whether the stored access token is past its declared expiry (unknown lifetime → false). */
  async accessTokenExpired(): Promise<boolean> {
    await this.load();
    const tokens = this.data.tokens;
    if (!tokens?.expires_in || !this.data.obtainedAt) return false;
    return Date.now() >= this.data.obtainedAt + tokens.expires_in * 1000;
  }

  /** Opaque marker used to notice credentials completed by another Airlock process/tool. */
  async tokenVersion(): Promise<string | undefined> {
    await this.load();
    if (!this.data.tokens) return undefined;
    return createHash('sha256').update(JSON.stringify(this.data.tokens)).digest('hex');
  }

  /** Wait until the token file changes (another process, an operator restore, or our refresh). */
  async waitForTokenChange(previous: string | undefined, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, TOKEN_CHANGE_POLL_MS);
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
      if (signal.aborted) return;
      if ((await this.tokenVersion()) !== previous) return;
    }
  }

  /**
   * Starts a temporary HTTP server to listen for the OAuth callback.
   * Returns a promise that resolves with the authorization code.
   */
  waitForAuthCode(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.authCodeResolve = resolve;

      this.callbackServer = createServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.callbackPort}`);
        if (url.pathname !== '/oauth/callback') {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        const state = url.searchParams.get('state');

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(
            '<html><body><h2>Authorization failed</h2><p>You can close this tab.</p></body></html>'
          );
          this.stopCallbackServer();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (code) {
          if (!this.isExpectedState(state)) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(
              '<html><body><h2>Authorization failed</h2><p>OAuth state mismatch.</p></body></html>'
            );
            this.stopCallbackServer();
            reject(new Error('OAuth state mismatch'));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h2>Authorized!</h2><p>You can close this tab.</p></body></html>');
          this.stopCallbackServer();
          this.authCodeResolve?.(code);
          return;
        }

        res.writeHead(400);
        res.end('Missing code parameter');
      });

      this.callbackServer.listen(this.callbackPort, '127.0.0.1', () => {
        log.info({ port: this.callbackPort }, 'OAuth callback server listening');
      });

      this.callbackServer.on('error', (err) => {
        log.error({ err }, 'OAuth callback server error');
        reject(err);
      });
    });
  }

  stopCallbackServer(): void {
    this.callbackServer?.close();
    this.callbackServer = undefined;
  }

  private isExpectedState(state: string | null): boolean {
    if (this.expectedState === undefined) return true;
    // Some authorization servers (e.g. Railway) issue no `state` on the authorize request, so
    // `expectedState` is '' and the callback carries no `state` param (=> null here). Requiring
    // '' === null rejected every legitimate callback and broke the whole loopback flow. When no
    // state was issued there is nothing to validate; the loopback redirect + PKCE already bind the
    // exchange. Scoped to the non-relay path so relay state-wrapping semantics are untouched.
    if (this.expectedState === '' && this.relayCallbackUrl === undefined) return true;
    if (state === this.expectedState) return true;
    return (
      this.relayCallbackUrl !== undefined && state === `${this.callbackPort}.${this.expectedState}`
    );
  }

  private async load(): Promise<void> {
    // Never replace a newer rotated token held in memory with the stale on-disk token merely
    // because the previous disk commit failed.
    if (this.persistenceDirty) return;
    try {
      const { data, corrupt } = await this.store.read();
      if (corrupt) {
        log.error(
          { serverId: this.serverId, path: this.store.path },
          'OAuth grant file is not valid JSON; leaving it untouched (it is backed up before any replacement)'
        );
      }
      this.data = data;
    } catch (err) {
      log.warn(
        { serverId: this.serverId, reason: err instanceof Error ? err.message : String(err) },
        'Could not read OAuth grant file; using the last state held in memory'
      );
    }
  }

  private async save(reason: string): Promise<void> {
    const snapshot = JSON.stringify(this.data);
    await this.store.write(this.data, reason);
    // A newer mutation may have arrived while this snapshot waited on the write queue. Only
    // declare the store clean when the file we just committed still represents current memory.
    if (snapshot === JSON.stringify(this.data)) {
      this.persistenceDirty = false;
      if (this.persistenceRetryTimer) {
        clearTimeout(this.persistenceRetryTimer);
        this.persistenceRetryTimer = undefined;
      }
    }
  }

  /** Commit a token change; on storage failure hold it in memory and retry only the disk write. */
  private async persistGrant(reason: string, fields: Record<string, unknown> = {}): Promise<void> {
    this.persistenceDirty = true;
    try {
      await this.save(reason);
      // Record the refresh chain without logging token values or token-derived fingerprints.
      log.info(
        {
          serverId: this.serverId,
          reason,
          refreshTokenPresent: Boolean(this.data.tokens?.refresh_token),
          ...fields,
          persisted: true,
        },
        'OAuth tokens saved'
      );
    } catch (err) {
      // The fresh token still works in this process. Do not make anyone re-run the token request:
      // with rotating refresh tokens that would spend the new token too. Retry only the disk write.
      log.warn(
        {
          serverId: this.serverId,
          reason,
          ...fields,
          error: err instanceof Error ? err.message : String(err),
        },
        'Could not persist OAuth tokens; holding them in memory and retrying storage'
      );
      this.schedulePersistenceRetry();
    }
  }

  private schedulePersistenceRetry(): void {
    if (this.persistenceRetryTimer) return;
    this.persistenceRetryTimer = setTimeout(() => {
      this.persistenceRetryTimer = undefined;
      void this.save('persistence-retry').catch((err) => {
        log.warn(
          { serverId: this.serverId, reason: err instanceof Error ? err.message : String(err) },
          'OAuth token persistence still unavailable; retrying'
        );
        this.schedulePersistenceRetry();
      });
    }, PERSIST_RETRY_MS);
    this.persistenceRetryTimer.unref?.();
  }
}
