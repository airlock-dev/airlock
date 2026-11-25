import { execFile } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { createServer, type Server as HttpServer } from 'http';
import { setTimeout as delay } from 'timers/promises';
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
  OAuthStoreConflictError,
  OAuthStoreReadOnlyError,
  grantIssuer,
  credentialFingerprint,
  drainGrantOperations,
  withGrantOperation,
  type ExchangeMarker,
  type OAuthStorageMode,
  type PersistedGrant,
} from './oauth-store.js';
import type { OAuthCallbackRouter } from './oauth-callback-router.js';

const log = childLogger('oauth');
let persistRetryMs = 30 * 1000;

/** Test hook: shorten the persistence retry interval (default 30 s). */
export function setPersistenceRetryMs(ms = 30 * 1000): void {
  persistRetryMs = ms;
}
const TOKEN_CHANGE_POLL_MS = 2 * 1000;
/**
 * Refresh at least this often while a refresh token is stored, even when the access token is
 * long-lived or has no declared lifetime, so refresh-token inactivity windows never lapse on an
 * idle gateway. Per provider: `oauth_max_refresh_interval_ms`.
 */
export const DEFAULT_MAX_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * What happened to a committed token change.
 * - `persisted`: durably written.
 * - `pending`: usable in memory, the disk write failed; retried until it succeeds.
 * - `superseded`: a different grant was stored meanwhile (new authorization, operator restore);
 *   the result was archived to history instead of overwriting it.
 * - `handed_off`: this process lost the writer lock during the exchange; the successor was parked
 *   for the lock holder, which adopts it.
 */
export type PersistResult = 'persisted' | 'pending' | 'superseded' | 'handed_off';

export type BeginExchangeResult =
  | { ok: true }
  | { ok: false; kind: 'read_only' | 'unwritable' | 'conflict'; message: string };

/** What the exchange was derived from (commit coherence check, orphan hand-off). */
export interface RefreshBasis {
  refreshToken: string;
  clientInfo: OAuthClientInformationFull;
  /** credentialFingerprint() of the stored grant the exchange started from. */
  credentials?: string;
  revision?: number;
  exchangeId?: string;
}

function sameExceptIssuer(a: object, b: object): boolean {
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  keys.delete('issuer');
  for (const key of keys) {
    if (JSON.stringify(ra[key]) !== JSON.stringify(rb[key])) return false;
  }
  return true;
}

/**
 * Where the browser's authorization redirect is received.
 * - `loopback`: a temporary listener on 127.0.0.1:<oauth_callback_port>. With `oauth_callback_url`
 *   set, an external relay forwards the callback there (the state carries the port).
 * - `gateway`: the running gateway's own data-plane listener serves `GET /oauth/callback` at the
 *   public `oauth_callback_url`, and an {@link OAuthCallbackRouter} hands the code to this provider.
 */
export type OAuthCallbackMode = 'loopback' | 'gateway';

export interface FileOAuthProviderOptions {
  /** `readonly` for CLI commands that must never refresh/write/invalidate. Default `writer`. */
  storage?: OAuthStorageMode;
  /** Override `~/.airlock/oauth` (tests). */
  storeDir?: string;
  callbackMode?: OAuthCallbackMode;
  /** Required for `gateway` mode; supplied by the gateway that serves the callback route. */
  callbackRouter?: OAuthCallbackRouter;
}

interface GatewayCallbackWait {
  promise: Promise<string>;
  resolve: (code: string) => void;
  reject: (err: Error) => void;
  settled: boolean;
}

/** Everything the refresh engine needs, read from the stored grant. */
export interface GrantSnapshot {
  tokens?: OAuthTokens;
  clientInfo?: OAuthClientInformationFull;
  issuer?: string;
  discovery?: OAuthDiscoveryState;
  resource?: string;
  obtainedAt?: number;
  exchange?: ExchangeMarker;
  /** Grant revision this snapshot was read from, and its credential fingerprint. */
  revision?: number;
  credentials: string;
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
 *
 * In-memory state vs disk: every mutation bumps `mutationGen`; a successful save records the
 * generation it wrote in `persistedGen`. While they differ, memory is authoritative and `load()`
 * does not read the file; a read that started before a mutation is discarded when it completes.
 * Saves are compare-and-swap against the file version memory was derived from, so an operator
 * restore (or any other writer) is never silently overwritten by stale memory.
 */
export class FileOAuthProvider implements OAuthClientProvider {
  readonly store: OAuthGrantStore;
  private data: PersistedGrant = {};
  private callbackServer?: HttpServer;
  private rejectLoopbackCallback?: (error: Error) => void;
  private stopped = false;
  private browserOpenedAt = 0;
  private expectedState?: string;
  private mutationGen = 0;
  private persistedGen = 0;
  /** Grant revision memory was derived from (undefined: unknown). */
  private diskRev: number | undefined;
  /**
   * Grants that must be kept but could not be written anywhere yet (history and orphan journal
   * both failed). Held in memory and retried with persistence; reported as persistence_pending.
   */
  private unpreserved: Array<{ grant: PersistedGrant; reason: string }> = [];
  /** The last save failed and memory holds changes that are not on disk yet. */
  private persistFailing = false;
  private persistenceRetryTimer?: NodeJS.Timeout;
  private readonly callbackMode: OAuthCallbackMode;
  private readonly callbackRouter?: OAuthCallbackRouter;
  /** Gateway mode: the code the pending authorization is waiting for. */
  private gatewayWait?: GatewayCallbackWait;
  private withdrawGatewayCallback?: () => void;
  /**
   * Gateway mode only. The SDK sends this as the authorize request's `state`; the gateway routes
   * the browser callback by it, so it must be present and unguessable for every authorization.
   * Left undefined in loopback mode so existing flows keep the SDK's own behavior.
   */
  state?: () => string;

  constructor(
    private serverId: string,
    private callbackPort: number,
    private preregisteredClientId?: string,
    private preregisteredClientSecret?: string,
    private relayCallbackUrl?: string,
    options: FileOAuthProviderOptions = {}
  ) {
    this.store = new OAuthGrantStore(serverId, options.storage ?? 'writer', options.storeDir);
    this.callbackMode = options.callbackMode ?? 'loopback';
    this.callbackRouter = options.callbackRouter;
    if (this.callbackMode === 'gateway') {
      if (!this.relayCallbackUrl) {
        throw new Error(
          `Provider "${serverId}" uses oauth_callback_mode: gateway without oauth_callback_url`
        );
      }
      this.state = () => randomBytes(32).toString('base64url');
    }
  }

  get storageMode(): OAuthStorageMode {
    return this.store.mode;
  }

  /** Whether this process may refresh/write this grant right now (holds the writer lock). */
  canWrite(): Promise<boolean> {
    return this.store.canWrite();
  }

  /**
   * Run a grant operation (refresh exchange, authorization-code exchange) exclusively for this
   * grant file within the process. See {@link withGrantOperation}.
   */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    return withGrantOperation(this.store.path, fn);
  }

  /** Set by {@link close}: no new token exchange may start. */
  closing = false;

  /**
   * Shutdown: admit no new exchanges, wait (up to `timeoutMs`) for one already sent to be committed
   * or parked, then make one last attempt to write anything still held only in memory. Returns
   * false when something could not be made durable in time (it is logged).
   */
  async close(timeoutMs: number): Promise<boolean> {
    this.closing = true;
    const drained = await drainGrantOperations(timeoutMs, this.store.path);
    if (!drained) {
      log.error(
        { serverId: this.serverId, timeoutMs },
        'OAuth exchange still in flight at shutdown deadline; its result may be lost'
      );
    }
    const persisted = this.persistencePending ? await this.retryPersistenceNow() : true;
    if (!persisted) {
      log.error(
        { serverId: this.serverId },
        'OAuth grant changes could not be written before shutdown'
      );
    }
    if (this.persistenceRetryTimer) {
      clearTimeout(this.persistenceRetryTimer);
      this.persistenceRetryTimer = undefined;
    }
    return drained && persisted;
  }

  /** Subscribe to "this process just acquired the OAuth writer lock". */
  onWriterAcquired(cb: () => void): () => void {
    return this.store.onLockAcquired(cb);
  }

  /** A token change is held in memory because the disk write failed (retrying). */
  get persistencePending(): boolean {
    return (
      (this.persistFailing && this.mutationGen !== this.persistedGen) || this.unpreserved.length > 0
    );
  }

  /** The unresolved refresh exchange recorded in the grant, if any (as last loaded). */
  get exchangeMarker(): ExchangeMarker | undefined {
    return this.data.exchange;
  }

  private touched(): void {
    this.mutationGen++;
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
    await this.loadForMutation();
    if (this.data.pending?.clientInfo?.client_id === info.client_id) {
      this.data.pending.clientInfo = info;
    } else if (this.data.clientInfo?.client_id === info.client_id || !this.data.tokens) {
      // Same registration (e.g. the SDK back-stamping its issuer) or no grant to protect yet.
      this.data.clientInfo = info;
    } else {
      // A new registration while a grant exists: stage it until the new authorization succeeds.
      this.data.pending = { startedAt: Date.now(), ...this.data.pending, clientInfo: info };
    }
    this.touched();
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
    try {
      await this.loadForMutation();
    } catch (err) {
      // The stored grant cannot be read, so nothing may be published on top of it. Tokens the
      // issuer just issued are kept anyway (history, else orphan journal, else memory + retry).
      if (tokens.refresh_token || tokens.access_token) {
        await this.preserve({ tokens }, 'unobserved-save');
      }
      throw err;
    }
    const stamped = tokens as StampedTokens;
    const current = this.data.tokens as StampedTokens | undefined;
    if (current && sameExceptIssuer(current, stamped)) {
      // Identical credentials; the SDK is only stamping the issuer (SEP-2352). Anything else (a
      // different refresh token, a completed authorization) is a real commit below.
      if (stamped.issuer && current.issuer !== stamped.issuer) {
        this.data.tokens = { ...current, issuer: stamped.issuer } as OAuthTokens;
        this.data.issuer ??= stamped.issuer;
        this.touched();
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
      this.touched();
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
    if (this.diskRev === undefined) return; // nothing observed: nothing staged to discard
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
    this.touched();
    await this.save('authorization-reset').catch(() => {});
  }

  /** True when this provider can receive an interactive browser callback in this process. */
  canHandleAuthCallback(): boolean {
    return this.callbackMode !== 'gateway' || Boolean(this.callbackRouter);
  }

  redirectToAuthorization(url: URL): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.callbackMode === 'gateway') {
      if (!this.callbackRouter) {
        log.warn(
          { serverId: this.serverId },
          'Skipping browser OAuth launch: oauth_callback_mode: gateway requires the gateway HTTP listener'
        );
        return Promise.resolve();
      }
      // The SDK has stored a new PKCE verifier. Show the corresponding URL every time we
      // supersede an attempt, so the operator always has a link that can complete the exchange.
      this.armGatewayCallback(url.searchParams.get('state') ?? '');
    } else {
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
    await this.loadForMutation();
    this.data.pending = { startedAt: Date.now(), ...this.data.pending, codeVerifier: verifier };
    delete this.data.codeVerifier;
    this.touched();
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
    await this.loadForMutation();
    this.data.pending = { startedAt: Date.now(), ...this.data.pending, discovery: state };
    this.touched();
    await this.save('authorization-discovery');
  }

  async saveResourceUrl(resourceUrl: string): Promise<void> {
    await this.loadForMutation();
    if (this.data.pending?.resource === resourceUrl) return;
    this.data.pending = { startedAt: Date.now(), ...this.data.pending, resource: resourceUrl };
    this.touched();
    await this.save('authorization-resource');
  }

  async saveAuthorizationServerUrl(issuer: string): Promise<void> {
    await this.loadForMutation();
    if (this.data.pending?.issuer === issuer) return;
    this.data.pending = { startedAt: Date.now(), ...this.data.pending, issuer };
    this.touched();
    await this.save('authorization-issuer');
  }

  /** Start a fresh authorization attempt: discard stale staged state, keep the stored grant. */
  async beginAuthorization(): Promise<void> {
    await this.loadForMutation();
    this.data.pending = { startedAt: Date.now() };
    delete this.data.codeVerifier;
    this.touched();
    await this.save('authorization-start');
  }

  // ─── Refresh-engine facing ────────────────────────────────────────────────────────────────────

  async grant(): Promise<GrantSnapshot> {
    await this.loadForMutation();
    return {
      tokens: this.data.tokens,
      clientInfo: this.preregisteredClient() ?? this.data.clientInfo,
      issuer: grantIssuer(this.data),
      discovery: this.data.discovery,
      resource: this.data.resource,
      obtainedAt: this.data.obtainedAt,
      ...(this.data.exchange ? { exchange: this.data.exchange } : {}),
      ...(this.diskRev !== undefined ? { revision: this.diskRev } : {}),
      credentials: credentialFingerprint(this.data),
    };
  }

  /**
   * Durably record that a refresh exchange is about to be sent. This is also the fencing check:
   * the write re-verifies the writer lock. When it fails nothing may be sent — a refresh token
   * must never be spent unless its successor can be committed.
   */
  async beginExchange(marker: ExchangeMarker): Promise<BeginExchangeResult> {
    try {
      await this.loadForMutation();
    } catch (err) {
      return {
        ok: false,
        kind: 'unwritable',
        message: err instanceof Error ? err.message : String(err),
      };
    }
    const wasClean = this.mutationGen === this.persistedGen;
    const previous = this.data.exchange;
    this.data.exchange = marker;
    this.touched();
    try {
      await this.save('refresh-start');
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof OAuthStoreConflictError) return { ok: false, kind: 'conflict', message };
      if (previous) this.data.exchange = previous;
      else delete this.data.exchange;
      this.touched();
      // The file still holds the pre-marker state; if memory was clean before, it is clean again.
      if (wasClean) this.persistedGen = this.mutationGen;
      return {
        ok: false,
        kind: err instanceof OAuthStoreReadOnlyError ? 'read_only' : 'unwritable',
        message,
      };
    }
  }

  /** Replace (or clear) the exchange marker after an exchange without a successor. */
  async endExchange(next: ExchangeMarker | undefined): Promise<void> {
    await this.loadForMutation();
    if (next) this.data.exchange = next;
    else delete this.data.exchange;
    this.touched();
    await this.persistGrant(next ? 'refresh-ambiguous' : 'refresh-end');
  }

  /**
   * Adopt successors parked by a process that lost the writer lock mid-exchange (call while
   * holding the lock, inside {@link runExclusive}). A successor whose predecessor is the stored
   * refresh token replaces it; any other is archived to history, never dropped.
   */
  async adoptOrphanedSuccessors(): Promise<void> {
    const orphans = await this.store.listOrphans();
    if (orphans.length === 0) return;
    await this.loadForMutation();
    for (const orphan of orphans) {
      const current = this.data.tokens?.refresh_token;
      // Adopt only while the stored credentials are exactly the ones the exchange started from.
      // Revisions that only changed markers or staged state do not block adoption; any credential
      // change (a later refresh — also with non-rotating refresh tokens — an authorization, a
      // restore) does, and the parked successor is then archived instead.
      // Orphans without a credential fingerprint (older format) are never adopted, only archived.
      const matches =
        Boolean(current) &&
        orphan.predecessorCredentials !== undefined &&
        orphan.predecessorCredentials === credentialFingerprint(this.data);
      if (matches) {
        const { pending: _pending, exchange: _exchange, ...grant } = orphan.grant;
        this.data = { ...grant, ...(this.data.pending ? { pending: this.data.pending } : {}) };
        this.touched();
        const result = await this.persistGrant('adopt-successor');
        if (result !== 'persisted') return; // keep the orphan file until the adoption is durable
        log.warn(
          { serverId: this.serverId },
          'Adopted an OAuth successor grant left by a process that lost the writer lock mid-refresh'
        );
      } else {
        if (!(await this.store.archive(orphan.grant, 'orphan-successor'))) {
          // No durable copy elsewhere: keep the orphan file itself, try again next time.
          log.warn(
            { serverId: this.serverId },
            'Could not archive an orphaned OAuth successor; keeping it parked'
          );
          continue;
        }
        log.warn(
          { serverId: this.serverId },
          'Archived an orphaned OAuth successor that no longer matches the stored grant (kept in history)'
        );
      }
      await this.store.removeOrphan(orphan.file);
    }
  }

  /**
   * Persist tokens obtained by refreshing the stored grant. With a `basis`, the commit is checked
   * for coherence first: when the stored grant is no longer the one that was refreshed (a new
   * authorization or a restore landed meanwhile) the result is archived instead of mixing one
   * grant's refresh token with another grant's client registration.
   */
  async commitRefresh(
    tokens: OAuthTokens,
    meta: RefreshCommit = {},
    basis?: RefreshBasis
  ): Promise<PersistResult> {
    // A fresh provider instance must load the persisted refresh token before handling a refresh
    // response that may omit it.
    await this.load();
    if (basis) {
      const currentClientId =
        this.preregisteredClient()?.client_id ?? this.data.clientInfo?.client_id;
      // Coherent only while the stored credentials are exactly the ones the exchange started
      // from (refresh + access token + client). A late result must never overwrite a newer
      // access token (non-rotating refresh tokens) or another grant's registration.
      const coherent = basis.credentials
        ? credentialFingerprint(this.data) === basis.credentials
        : this.data.tokens?.refresh_token === basis.refreshToken &&
          currentClientId === basis.clientInfo.client_id;
      if (!coherent) {
        await this.preserve(
          {
            clientInfo: basis.clientInfo,
            tokens: tokens.refresh_token
              ? tokens
              : { ...tokens, refresh_token: basis.refreshToken },
            obtainedAt: Date.now(),
            ...(meta.issuer ? { issuer: meta.issuer } : {}),
            ...(meta.discovery ? { discovery: meta.discovery } : {}),
            ...(meta.resource ? { resource: meta.resource } : {}),
          },
          'superseded-refresh'
        );
        log.warn(
          { serverId: this.serverId },
          'A different OAuth grant was stored while a refresh was in flight; kept the stored grant and archived the refresh result to history'
        );
        return 'superseded';
      }
    }
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
    delete this.data.exchange; // committed in the same write that stores the successor
    this.touched();
    return this.persistGrant(
      'refresh',
      {
        refreshTokenReturned,
        refreshTokenRotated,
        accessExpiresInSec: tokens.expires_in,
        previousTokenAgeSec: previousObtainedAt
          ? Math.floor((this.data.obtainedAt - previousObtainedAt) / 1000)
          : undefined,
      },
      basis
    );
  }

  /**
   * How long (ms) until the grant should be proactively refreshed: `bufferMs` before the access
   * token expires, and in any case no later than `maxIntervalMs` after the tokens were obtained (so
   * a refresh token with an inactivity window is exercised even when the access token is
   * long-lived or declares no lifetime). Returns `undefined` only without a refresh_token. Never
   * negative. Tokens persisted before `obtainedAt` existed report `0` (refresh promptly).
   */
  async msUntilRefresh(
    bufferMs: number,
    maxIntervalMs: number = DEFAULT_MAX_REFRESH_INTERVAL_MS
  ): Promise<number | undefined> {
    await this.load();
    const tokens = this.data.tokens;
    if (!tokens?.refresh_token) return undefined;
    const obtainedAt = this.data.obtainedAt ?? 0;
    let dueAt = obtainedAt + maxIntervalMs;
    if (tokens.expires_in) {
      const lifetimeMs = tokens.expires_in * 1000;
      const effectiveBufferMs = adaptiveExpiryBuffer(lifetimeMs, bufferMs);
      dueAt = Math.min(dueAt, obtainedAt + lifetimeMs - effectiveBufferMs);
    }
    return Math.max(0, dueAt - Date.now());
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
      try {
        await delay(TOKEN_CHANGE_POLL_MS, undefined, { ref: false, signal });
      } catch (err) {
        if (signal.aborted) return;
        throw err;
      }
      if (signal.aborted) return;
      if ((await this.tokenVersion()) !== previous) return;
    }
  }

  /**
   * Resolves with the authorization code from the browser callback. In loopback mode this starts a
   * temporary HTTP listener; in gateway mode it waits for the gateway's callback route to deliver
   * the code for this provider's pending state.
   */
  waitForAuthCode(): Promise<string> {
    if (this.stopped) return Promise.reject(new Error('OAuth callback cancelled'));
    if (this.callbackMode === 'gateway') {
      if (!this.callbackRouter) {
        return Promise.reject(
          new Error(
            `Provider "${this.serverId}" uses oauth_callback_mode: gateway, which needs the Airlock gateway's HTTP listener`
          )
        );
      }
      return this.getGatewayWait().promise;
    }
    return new Promise((resolve, reject) => {
      this.rejectLoopbackCallback = reject;

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
          reject(new Error(`OAuth error: ${error}`));
          this.stopCallbackServer();
          return;
        }

        if (code) {
          if (!this.isExpectedState(state)) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(
              '<html><body><h2>Authorization failed</h2><p>OAuth state mismatch.</p></body></html>'
            );
            reject(new Error('OAuth state mismatch'));
            this.stopCallbackServer();
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h2>Authorized!</h2><p>You can close this tab.</p></body></html>');
          resolve(code);
          this.stopCallbackServer();
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
        this.stopCallbackServer();
      });
    });
  }

  stopCallbackServer(): void {
    this.callbackServer?.close();
    this.callbackServer = undefined;
    this.withdrawGatewayCallback?.();
    this.withdrawGatewayCallback = undefined;
    const error = new Error('OAuth callback cancelled');
    this.rejectLoopbackCallback?.(error);
    this.rejectLoopbackCallback = undefined;
    this.gatewayWait?.reject(error);
    this.gatewayWait = undefined;
  }

  stop(): void {
    // An SDK authorization already in progress may still call redirectToAuthorization.
    this.stopped = true;
    this.stopCallbackServer();
  }

  private getGatewayWait(): GatewayCallbackWait {
    if (!this.gatewayWait) {
      let resolve!: GatewayCallbackWait['resolve'];
      let reject!: GatewayCallbackWait['reject'];
      const promise = new Promise<string>((resolveCode, rejectCode) => {
        resolve = resolveCode;
        reject = rejectCode;
      });
      // A callback can fail before the client starts waiting. Preserve the rejection for it.
      void promise.catch(() => {});
      this.gatewayWait = { promise, resolve, reject, settled: false };
    }
    return this.gatewayWait;
  }

  private armGatewayCallback(state: string): void {
    if (!this.callbackRouter) return; // waitForAuthCode reports the missing gateway listener.
    // An existing waiter can follow a replacement state while its attempt is still pending.
    // Once a callback has settled, a later attempt needs a fresh promise.
    this.withdrawGatewayCallback?.();
    this.withdrawGatewayCallback = undefined;
    if (this.gatewayWait?.settled) this.gatewayWait = undefined;
    const wait = this.getGatewayWait();
    if (!state) {
      wait.settled = true;
      wait.reject(new Error('OAuth authorization request carried no state to route the callback'));
      return;
    }
    this.withdrawGatewayCallback = this.callbackRouter.register(state, this.serverId, (outcome) => {
      this.withdrawGatewayCallback = undefined;
      wait.settled = true;
      if ('code' in outcome) {
        wait.resolve(outcome.code);
      } else {
        wait.reject(new Error(`OAuth error: ${outcome.error}`));
      }
    });
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
    // Memory with changes that are not on disk yet (a rotated token whose commit failed, staged
    // state being written) is authoritative: never replace it with the older file.
    if (this.mutationGen !== this.persistedGen) return;
    const generation = this.mutationGen;
    let result: Awaited<ReturnType<OAuthGrantStore['read']>>;
    try {
      result = await this.store.read();
    } catch (err) {
      log.warn(
        { serverId: this.serverId, reason: err instanceof Error ? err.message : String(err) },
        'Could not read OAuth grant file; using the last state held in memory'
      );
      return;
    }
    // A mutation landed while the read was in flight: the read is stale, discard it.
    if (this.mutationGen !== generation || this.mutationGen !== this.persistedGen) return;
    if (result.corrupt) {
      log.error(
        { serverId: this.serverId, path: this.store.path },
        'OAuth grant file is not valid JSON; leaving it untouched (it is backed up before any replacement)'
      );
    }
    this.data = result.data;
    this.diskRev = result.rev;
  }

  /**
   * Load for a mutation: the change must be based on a successfully observed revision (a read that
   * succeeded, or found nothing). A failed read never turns into "empty grant" + publish.
   */
  private async loadForMutation(): Promise<void> {
    await this.load();
    if (this.diskRev === undefined) {
      throw new Error('the stored OAuth grant could not be read; not changing it');
    }
  }

  private async save(reason: string, opts: { keepOnConflict?: boolean } = {}): Promise<void> {
    const generation = this.mutationGen;
    if (this.diskRev === undefined) {
      // Never publish without knowing which revision this change is based on.
      throw new Error('the stored OAuth grant has not been read successfully; not writing');
    }
    const snapshot = JSON.parse(JSON.stringify(this.data)) as PersistedGrant;
    let rev: number;
    try {
      ({ rev } = await this.store.write(snapshot, reason, {
        expectRev: this.diskRev,
        // Replacing a grant with a different one: the previous one must be safely in history.
        ...(reason === 'authorization' ? { backup: 'before' as const } : {}),
      }));
    } catch (err) {
      if (err instanceof OAuthStoreConflictError && !opts.keepOnConflict) {
        await this.resolveConflict(reason);
      }
      throw err;
    }
    if (generation >= this.persistedGen) {
      this.persistedGen = generation;
      this.diskRev = rev;
    }
    // Keep retrying while anything is still held only in memory (also unpreserved copies).
    if (this.persistedGen === this.mutationGen && this.unpreserved.length === 0) {
      this.persistFailing = false;
      if (this.persistenceRetryTimer) {
        clearTimeout(this.persistenceRetryTimer);
        this.persistenceRetryTimer = undefined;
      }
    }
  }

  /**
   * The file changed under us (operator restore, another writer). Keep what we had in history —
   * never drop it — then follow the file.
   */
  private async resolveConflict(reason: string): Promise<void> {
    if (this.mutationGen !== this.persistedGen && (this.data.tokens || this.data.clientInfo)) {
      const { pending: _pending, exchange: _exchange, ...unsaved } = this.data;
      if (!(await this.preserve(unsaved, `unsaved-${reason}`))) {
        // preserve() keeps it in memory and retries; following the file is now safe.
        log.warn(
          { serverId: this.serverId },
          'Unsaved OAuth state held in memory until it can be archived'
        );
      }
    }
    log.warn(
      { serverId: this.serverId, reason },
      'OAuth grant file changed on disk (operator restore or another writer); following the file, unsaved in-memory state archived to history'
    );
    this.persistedGen = this.mutationGen;
    if (this.unpreserved.length === 0) {
      this.persistFailing = false;
      if (this.persistenceRetryTimer) {
        clearTimeout(this.persistenceRetryTimer);
        this.persistenceRetryTimer = undefined;
      }
    }
    this.diskRev = undefined;
    await this.load();
  }

  /**
   * Keep a grant that is not (or no longer) the stored one: durably in history, else as a parked
   * successor, else in memory with retries (never dropped). True when it is on disk.
   */
  private async preserve(grant: PersistedGrant, reason: string): Promise<boolean> {
    if (await this.store.archive(grant, reason)) return true;
    try {
      await this.store.writeOrphan(grant, {
        presentedRefreshToken: '',
        predecessorCredentials: 'never-adopt',
      });
      return true;
    } catch {
      this.unpreserved.push({ grant, reason });
      this.persistFailing = true;
      this.schedulePersistenceRetry();
      log.error(
        { serverId: this.serverId, reason },
        'Could not write an OAuth grant copy anywhere; holding it in memory and retrying'
      );
      return false;
    }
  }

  private async flushUnpreserved(): Promise<boolean> {
    // An item leaves the list only once its copy is durable, so persistencePending stays true
    // for as long as anything exists only in memory.
    for (const item of [...this.unpreserved]) {
      if (await this.store.archive(item.grant, item.reason)) {
        this.unpreserved.splice(this.unpreserved.indexOf(item), 1);
      }
    }
    return this.unpreserved.length === 0;
  }

  /**
   * Commit a token change. On storage failure hold it in memory and retry only the disk write;
   * when this process lost the writer lock during the exchange, park it for the lock holder.
   */
  private async persistGrant(
    reason: string,
    fields: Record<string, unknown> = {},
    basis?: RefreshBasis
  ): Promise<PersistResult> {
    try {
      // A refresh commit that loses the race for publication must not be resolved by archiving
      // and following the file: its successor goes to the orphan journal for the owner to adopt.
      await this.save(reason, { keepOnConflict: Boolean(basis) });
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
      return 'persisted';
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const lostOwnership =
        err instanceof OAuthStoreReadOnlyError || err instanceof OAuthStoreConflictError;
      if (lostOwnership && basis) {
        const { pending: _pending, exchange: _exchange, ...successor } = this.data;
        try {
          await this.store.writeOrphan(successor, {
            presentedRefreshToken: basis.refreshToken,
            predecessorCredentials: basis.credentials ?? '',
            ...(basis.revision !== undefined ? { predecessorRevision: basis.revision } : {}),
            ...(basis.exchangeId ? { exchangeId: basis.exchangeId } : {}),
          });
          // The holder (or the newer revision's writer) owns the grant now; follow the file.
          this.persistedGen = this.mutationGen;
          this.persistFailing = false;
          this.diskRev = undefined;
          log.warn(
            { serverId: this.serverId, reason, error },
            'Could not publish the refreshed OAuth grant (writer lock lost or a newer revision exists); parked the successor for adoption'
          );
          return 'handed_off';
        } catch (orphanErr) {
          log.warn(
            {
              serverId: this.serverId,
              error: orphanErr instanceof Error ? orphanErr.message : String(orphanErr),
            },
            'Could not park an OAuth successor for adoption; holding it in memory'
          );
        }
      } else if (err instanceof OAuthStoreConflictError) {
        return 'superseded';
      }
      // The fresh token still works in this process. Do not make anyone re-run the token request:
      // with rotating refresh tokens that would spend the new token too. Retry only the disk write.
      log.warn(
        { serverId: this.serverId, reason, ...fields, error },
        'Could not persist OAuth tokens; holding them in memory and retrying storage'
      );
      this.persistFailing = true;
      this.schedulePersistenceRetry();
      return 'pending';
    }
  }

  /** Retry pending disk writes now (also used by tests and at shutdown). */
  async retryPersistenceNow(): Promise<boolean> {
    const preserved = await this.flushUnpreserved();
    if (this.mutationGen === this.persistedGen) return preserved;
    try {
      await this.save('persistence-retry');
      return preserved && this.mutationGen === this.persistedGen;
    } catch {
      return false;
    }
  }

  private schedulePersistenceRetry(): void {
    if (this.persistenceRetryTimer) return;
    this.persistenceRetryTimer = setTimeout(() => {
      this.persistenceRetryTimer = undefined;
      void this.retryPersistenceNow().then((done) => {
        if (done) return;
        log.warn(
          { serverId: this.serverId },
          'OAuth token persistence still unavailable; retrying'
        );
        this.persistFailing = true;
        this.schedulePersistenceRetry();
      });
    }, persistRetryMs);
    this.persistenceRetryTimer.unref?.();
  }
}
