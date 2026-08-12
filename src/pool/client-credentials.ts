import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import type { ClientCredentialsConfig } from '../config/schema.js';
import { childLogger } from '../util/logger.js';
import { atomicWritePrivateFile } from '../util/atomic-file.js';
import { adaptiveExpiryBuffer } from './oauth-timing.js';

const log = childLogger('client-credentials');

/**
 * Re-mint this long before the token actually expires. Same buffer the authorization-code path uses
 * for proactive refresh — enough slack to absorb a slow issuer and clock skew between us and it.
 */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const PERSIST_RETRY_MS = 30 * 1000;

/** OAuth2 error codes that mean "these credentials are wrong", not "this request went wrong". */
const FATAL_ERROR_CODES = ['invalid_client', 'unauthorized_client', 'invalid_scope'];

interface CachedToken {
  access_token: string;
  /** Epoch ms, or absent when the issuer declared no lifetime (then only a 401 retires the token). */
  expires_at?: number;
  /** Epoch ms used to derive an adaptive safety buffer for short-lived tokens. */
  obtained_at?: number;
  /** The scope string this token was minted for; a config change must invalidate the cache. */
  scope?: string;
}

/**
 * Mints and caches an OAuth2 client-credentials token: the gateway authenticating as the
 * application itself, no user and no browser in the loop.
 *
 * Three properties matter here, all learned from how real issuers behave:
 *
 * 1. **The disk cache is not an optimization.** Issuers cap how many client-credentials tokens an
 *    app may hold concurrently (Linear: 1000, and only if every token shares the same scopes). A
 *    gateway that minted fresh on each restart would grind through that quota and then start
 *    failing for reasons no log would explain. So tokens outlive the process.
 * 2. **Fatal vs transient is a real distinction.** A wrong secret (`invalid_client`) must surface as
 *    `auth_required` and stop retrying; a 503 from the issuer must not. `lastAuthFailure` carries
 *    the former to the health endpoint.
 * 3. **Single-flight.** A burst of concurrent requests on a cold cache must mint ONE token, not one
 *    per request — otherwise the quota above is spent in a single reconnect storm.
 */
export class ClientCredentialsTokenSource {
  private cached?: CachedToken;
  private loaded = false;
  private inflight?: Promise<string>;
  private authFailure?: string;
  private readonly storePath: string;
  private persistenceRetryTimer?: NodeJS.Timeout;

  constructor(
    private id: string,
    private cfg: ClientCredentialsConfig,
    storeDir = join(homedir(), '.airlock', 'oauth')
  ) {
    this.storePath = join(storeDir, `${id}.client-credentials.json`);
  }

  /**
   * The reason the last mint failed *fatally* (bad credentials/scope), or undefined. Read by the
   * connection-status path so a provider with a dead secret reports `auth_required` rather than
   * masquerading as a network outage.
   */
  get lastAuthFailure(): string | undefined {
    return this.authFailure;
  }

  /**
   * A usable access token. Returns the cached one when it is still comfortably valid; otherwise
   * mints. Pass `force` after a 401 to discard a token the issuer has stopped honouring — expiry
   * is not the only way a token dies (secret rotation revokes every live token at once).
   */
  async getToken(force = false): Promise<string> {
    if (!this.loaded) await this.load();
    if (!force) {
      const usable = this.usableToken();
      if (usable) return usable;
    } else {
      this.cached = undefined;
    }
    // Single-flight: everyone waiting on a cold cache shares one mint.
    this.inflight ??= this.mint().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private usableToken(): string | undefined {
    if (!this.cached) return undefined;
    // Scope changed in config since this token was minted — it may carry the wrong grants, and on
    // some issuers the old token is already revoked. Re-mint rather than trust it.
    if ((this.cached.scope ?? undefined) !== (this.cfg.scope ?? undefined)) return undefined;
    // No declared lifetime: the issuer never promised an expiry, so hold it until a 401 says
    // otherwise. Re-minting on a guessed interval would burn the concurrent-token quota.
    if (this.cached.expires_at === undefined) return this.cached.access_token;
    const lifetimeMs = this.cached.obtained_at
      ? this.cached.expires_at - this.cached.obtained_at
      : undefined;
    const bufferMs = lifetimeMs
      ? adaptiveExpiryBuffer(lifetimeMs, EXPIRY_BUFFER_MS)
      : EXPIRY_BUFFER_MS;
    if (Date.now() >= this.cached.expires_at - bufferMs) return undefined;
    return this.cached.access_token;
  }

  private async mint(): Promise<string> {
    const body = new URLSearchParams({ grant_type: 'client_credentials' });
    if (this.cfg.scope) body.set('scope', this.cfg.scope);

    // HTTP Basic (`client_secret_basic`) is the OAuth2-recommended client authentication method and
    // the one every issuer supports; the secret stays out of the body.
    const basic = Buffer.from(`${this.cfg.client_id}:${this.cfg.client_secret}`).toString('base64');

    let res: Response;
    try {
      res = await fetch(this.cfg.token_url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body,
      });
    } catch (err) {
      // Network-level: the credentials may be perfectly good, so do NOT record an auth failure.
      throw new Error(
        `client-credentials mint failed for ${this.id}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }

    const text = await res.text();
    if (!res.ok) {
      const code = parseErrorCode(text);
      const reason = `token endpoint returned ${res.status}${code ? ` (${code})` : ''}`;
      if (code && FATAL_ERROR_CODES.includes(code)) {
        this.authFailure = `client credentials rejected: ${code}`;
        log.error({ id: this.id, status: res.status, code }, 'Client-credentials mint rejected');
      } else {
        log.warn({ id: this.id, status: res.status }, 'Client-credentials mint failed');
      }
      throw new Error(`client-credentials mint failed for ${this.id}: ${reason}`);
    }

    let parsed: { access_token?: unknown; expires_in?: unknown };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      throw new Error(`client-credentials mint failed for ${this.id}: token response was not JSON`);
    }
    if (typeof parsed.access_token !== 'string' || !parsed.access_token) {
      throw new Error(`client-credentials mint failed for ${this.id}: no access_token in response`);
    }

    const token: CachedToken = { access_token: parsed.access_token };
    if (typeof parsed.expires_in === 'number' && parsed.expires_in > 0) {
      token.obtained_at = Date.now();
      token.expires_at = token.obtained_at + parsed.expires_in * 1000;
    }
    if (this.cfg.scope !== undefined) token.scope = this.cfg.scope;

    this.cached = token;
    this.authFailure = undefined;
    await this.save();
    log.info(
      {
        id: this.id,
        expiresAt: token.expires_at ? new Date(token.expires_at).toISOString() : null,
      },
      'Minted client-credentials token'
    );
    return token.access_token;
  }

  private async load(): Promise<void> {
    this.loaded = true;
    try {
      const data = await readFile(this.storePath, 'utf-8');
      this.cached = JSON.parse(data) as CachedToken;
    } catch {
      this.cached = undefined;
    }
  }

  private async save(): Promise<void> {
    try {
      await atomicWritePrivateFile(this.storePath, JSON.stringify(this.cached, null, 2));
      if (this.persistenceRetryTimer) {
        clearTimeout(this.persistenceRetryTimer);
        this.persistenceRetryTimer = undefined;
      }
    } catch (err) {
      // A token we can't persist still works for this process — degrade to in-memory rather than
      // failing the request that triggered the mint.
      log.warn(
        { id: this.id, reason: err instanceof Error ? err.message : String(err) },
        'Could not persist client-credentials token; holding it in memory only'
      );
      this.schedulePersistenceRetry();
    }
  }

  private schedulePersistenceRetry(): void {
    if (this.persistenceRetryTimer) return;
    this.persistenceRetryTimer = setTimeout(() => {
      this.persistenceRetryTimer = undefined;
      void this.save();
    }, PERSIST_RETRY_MS);
    this.persistenceRetryTimer.unref?.();
  }
}

/** Pull the OAuth2 `error` code out of a token-endpoint error body, if it is JSON and has one. */
function parseErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed.error === 'string' ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}
