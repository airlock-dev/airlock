import {
  OAuthError,
  OAuthErrorCode,
  checkResourceAllowed,
  discoverOAuthServerInfo,
  refreshAuthorization,
  resourceUrlFromServerUrl,
} from '@modelcontextprotocol/client';
import type { OAuthDiscoveryState, OAuthTokens } from '@modelcontextprotocol/client';
import type { FileOAuthProvider, PersistResult } from './oauth-provider.js';
import { randomUUID } from 'crypto';
import type { ExchangeMarker } from './oauth-store.js';
import { childLogger } from '../util/logger.js';

const log = childLogger('oauth-refresh');

/** Upper bound for any single discovery or token request. */
export const OAUTH_REQUEST_TIMEOUT_MS = 15_000;
let requestTimeoutMs = OAUTH_REQUEST_TIMEOUT_MS;

/** Test hook: shorten the OAuth request timeout. */
export function setOAuthRequestTimeout(ms: number = OAUTH_REQUEST_TIMEOUT_MS): void {
  requestTimeoutMs = ms;
}

/** fetch with a hard timeout, for OAuth metadata and token endpoints. */
export function oauthFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const timeout = AbortSignal.timeout(requestTimeoutMs);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetch(url, { ...init, signal });
}

/** OAuth error codes that mean "the issuer rejected this grant/client" (as opposed to an outage). */
const REJECTION_CODES = new Set<string>([
  OAuthErrorCode.InvalidGrant,
  OAuthErrorCode.InvalidClient,
  OAuthErrorCode.UnauthorizedClient,
]);

/**
 * Error codes (anywhere in an error's `cause` chain) that prove the token request never left this
 * host: name resolution, connection establishment, TLS verification.
 */
const NOT_SENT_CODES = new Set<string>([
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_NONAME',
  'EAI_FAIL',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
  'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_INVALID_URL',
]);

/** Statuses from a proxy in front of the issuer that do not tell whether the issuer processed it. */
const AMBIGUOUS_STATUSES = new Set([502, 504, 520, 524]);
/** Statuses meaning there is no token endpoint here (the request was not processed). */
const GONE_STATUSES = new Set([404, 405, 410]);
/**
 * A pinned (ambiguous) exchange whose endpoint has been gone or unreachable this long is reported
 * as `grant_rejected` (endpoint retired). The grant and the marker are still kept; nothing is
 * dropped, and a successful refresh or a new authorization clears it.
 */
export const PINNED_ENDPOINT_RETIRED_MS = 7 * 24 * 60 * 60 * 1000;

/** How long shutdown waits for an in-flight token exchange to be committed (request + commit). */
export const OAUTH_SHUTDOWN_DRAIN_MS = OAUTH_REQUEST_TIMEOUT_MS + 5_000;
/**
 * Graceful-shutdown deadline before a forced exit (gateway and stdio mode). Longer than the OAuth
 * drain so an exchange in flight is committed; a container's stop grace period (Docker's default
 * is 10 s) must be longer still, e.g. compose `stop_grace_period: 40s`.
 */
export const SHUTDOWN_FORCE_EXIT_MS = OAUTH_SHUTDOWN_DRAIN_MS + 5_000;

export type RefreshOutcome =
  | {
      kind: 'refreshed';
      issuer?: string;
      /** Set when discovery advertises a different issuer than the stored grant's. */
      issuerChange?: { from: string; to: string };
      /** True when the grant moved to the newly advertised issuer in this refresh. */
      migrated?: boolean;
      /** `persisted`, or `superseded` (a different grant was stored meanwhile; result archived). */
      persistence: Extract<PersistResult, 'persisted' | 'superseded'>;
    }
  /**
   * The exchange succeeded and the successor is usable from memory, but it is NOT on disk yet
   * (the write failed and is being retried). Not reported as a success.
   */
  | {
      kind: 'unpersisted';
      issuer?: string;
      issuerChange?: { from: string; to: string };
      migrated?: boolean;
      message: string;
    }
  /** No refresh token stored: only an interactive authorization can produce a grant. */
  | { kind: 'no_grant'; reason: string }
  /** The issuer explicitly rejected the grant (invalid_grant & co). The grant is kept on disk. */
  | {
      kind: 'rejected';
      code: string;
      message: string;
      issuer?: string;
      issuerChange?: { from: string; to: string };
      /** The rejection followed an ambiguous exchange: the token was probably consumed then. */
      afterAmbiguous?: boolean;
    }
  /** Anything else: network, 5xx, timeout, malformed response, discovery outage, storage. */
  | {
      kind: 'failed';
      message: string;
      issuer?: string;
      issuerChange?: { from: string; to: string };
      /** The request may have reached the issuer; the refresh token may have been rotated. */
      ambiguous?: boolean;
    }
  /** This process may not write the grant (read-only command, or another process holds the lock). */
  | { kind: 'read_only'; reason: string };

interface Target {
  label: 'known-good' | 'live' | 'pinned';
  issuer: string;
  discovery: OAuthDiscoveryState;
  resource?: string;
}

type ExchangeClass = 'not_sent' | 'gone' | 'rejected' | 'failed' | 'ambiguous';

function issuersMatch(a: string, b: string): boolean {
  const strip = (s: string) => (s.endsWith('/') ? s.slice(0, -1) : s);
  return strip(a) === strip(b);
}

function issuerOf(state: OAuthDiscoveryState): string {
  return state.authorizationServerMetadata?.issuer ?? String(state.authorizationServerUrl);
}

function authMethods(state: OAuthDiscoveryState): string {
  return JSON.stringify(
    [...(state.authorizationServerMetadata?.token_endpoint_auth_methods_supported ?? [])].sort()
  );
}

function tokenEndpoint(state: OAuthDiscoveryState): string {
  return (
    state.authorizationServerMetadata?.token_endpoint ??
    new URL('/token', state.authorizationServerUrl).href
  );
}

function describeError(err: unknown): string {
  if (err instanceof OAuthError) return `${err.code}: ${err.message}`.slice(0, 300);
  if (err instanceof Error) {
    const code = errorCode(err);
    const first = err.message.split('\n')[0] ?? err.name;
    return (code && !first.includes(code) ? `${first} (${code})` : first).slice(0, 300);
  }
  return String(err).slice(0, 300);
}

function errorCode(err: unknown): string | undefined {
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/** What the token request did on the wire, for telling "never sent" from "answer lost". */
interface WireTrace {
  invoked: boolean;
  responded: boolean;
  status?: number;
  contentType?: string;
  bodyFailed?: boolean;
  error?: unknown;
}

/** oauthFetch that records the wire trace and reads the body itself (to see a mid-body reset). */
function tracingFetch(trace: WireTrace): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    trace.invoked = true;
    let res: Response;
    try {
      res = await oauthFetch(url as string | URL, init);
    } catch (err) {
      trace.error = err;
      throw err;
    }
    trace.responded = true;
    trace.status = res.status;
    trace.contentType = res.headers.get('content-type') ?? '';
    let body: string;
    try {
      body = await res.text();
    } catch (err) {
      trace.bodyFailed = true;
      trace.error = err;
      throw err;
    }
    const nullBody = res.status === 204 || res.status === 205 || res.status === 304;
    return new Response(nullBody ? null : body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }) as typeof fetch;
}

/**
 * Classify a failed token request:
 * - `not_sent`: provably never left this host (DNS, connect refused, TLS) → token not consumed.
 * - `gone`: no token endpoint answered there (404/405/410 without an OAuth error) → not consumed.
 * - `rejected`: the issuer answered invalid_grant/invalid_client/unauthorized_client.
 * - `failed`: the issuer answered with an error status without issuing tokens.
 * - `ambiguous`: the request may have been processed but the answer was lost (timeout, reset after
 *   sending, a body cut off, 502/504 from a proxy, any 2xx whose body is unusable).
 */
function classifyExchange(err: unknown, trace: WireTrace): ExchangeClass {
  if (!trace.invoked) return 'not_sent';
  if (!trace.responded) {
    const code = errorCode(trace.error);
    return code && NOT_SENT_CODES.has(code) ? 'not_sent' : 'ambiguous';
  }
  if (trace.bodyFailed) return 'ambiguous';
  if (err instanceof OAuthError && REJECTION_CODES.has(err.code)) return 'rejected';
  const status = trace.status ?? 0;
  // Any success status whose body we could not use may have carried the successor (whatever the
  // content type claims): the issuer may have rotated the refresh token.
  if (status >= 200 && status < 300) return 'ambiguous';
  if (AMBIGUOUS_STATUSES.has(status)) return 'ambiguous';
  // A 404/405/410 carrying a real OAuth error body came from the issuer; without one there is no
  // token endpoint at that URL any more.
  const issuerErrorBody =
    err instanceof OAuthError && !err.message.includes('Invalid OAuth error response');
  if (GONE_STATUSES.has(status) && !issuerErrorBody) return 'gone';
  return 'failed';
}

/**
 * Live discovery result, or undefined when it failed or is *degraded* compared to what we know
 * works. The SDK's discovery silently falls back to "the MCP server origin is the authorization
 * server" when protected-resource metadata is unavailable; refreshing against that fallback is
 * exactly how Railway ended up sending refreshes without a `resource` to the wrong place.
 */
async function liveDiscovery(
  serverUrl: string,
  known: OAuthDiscoveryState | undefined,
  hintResourceMetadataUrl: URL | undefined
): Promise<{ state?: OAuthDiscoveryState; problem?: string }> {
  const resourceMetadataUrl =
    hintResourceMetadataUrl ??
    (known?.resourceMetadataUrl ? new URL(known.resourceMetadataUrl) : undefined);
  try {
    const info = await discoverOAuthServerInfo(serverUrl, {
      resourceMetadataUrl,
      fetchFn: oauthFetch,
    });
    const state: OAuthDiscoveryState = {
      authorizationServerUrl: String(info.authorizationServerUrl),
      resourceMetadata: info.resourceMetadata,
      authorizationServerMetadata: info.authorizationServerMetadata,
      ...(resourceMetadataUrl ? { resourceMetadataUrl: resourceMetadataUrl.toString() } : {}),
    };
    if (known?.resourceMetadata && !state.resourceMetadata) {
      return { problem: 'protected resource metadata unavailable' };
    }
    if (known?.authorizationServerMetadata && !state.authorizationServerMetadata) {
      return { problem: 'authorization server metadata unavailable' };
    }
    return { state };
  } catch (err) {
    return { problem: describeError(err) };
  }
}

/** The RFC 8707 resource indicator for a refresh: the one recorded at authorization wins. */
function resourceFor(
  serverUrl: string,
  recorded: string | undefined,
  discovery: OAuthDiscoveryState
): string | undefined {
  if (recorded) return recorded;
  const prm = discovery.resourceMetadata?.resource;
  if (!prm) return undefined;
  const allowed = checkResourceAllowed({
    requestedResource: resourceUrlFromServerUrl(serverUrl),
    configuredResource: prm,
  });
  return allowed ? prm : undefined;
}

const inflight = new Map<string, Promise<RefreshOutcome>>();

/**
 * Refresh the stored grant. Single-flight per token file (concurrent proactive and reactive
 * refreshes share one token request), and serialized with authorization-code exchanges and
 * restores of the same grant (see `withGrantOperation`).
 *
 * Never deletes or overwrites the stored grant except with a coherent, successful refresh result.
 */
export function refreshGrant(
  provider: FileOAuthProvider,
  serverUrl: string,
  opts: { resourceMetadataUrl?: URL } = {}
): Promise<RefreshOutcome> {
  const key = provider.store.path;
  const existing = inflight.get(key);
  if (existing) return existing;
  if (provider.closing) {
    return Promise.resolve({ kind: 'read_only', reason: 'Airlock is shutting down' });
  }
  const run = provider
    .runExclusive(() => doRefresh(provider, serverUrl, opts))
    .catch((err: unknown): RefreshOutcome => ({ kind: 'failed', message: describeError(err) }))
    .finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}

async function doRefresh(
  provider: FileOAuthProvider,
  serverUrl: string,
  opts: { resourceMetadataUrl?: URL }
): Promise<RefreshOutcome> {
  const serverId = provider.store.serverId;
  if (provider.storageMode === 'readonly') {
    return { kind: 'read_only', reason: 'read-only command; the gateway owns token refresh' };
  }
  if (!(await provider.canWrite())) {
    return {
      kind: 'read_only',
      reason: `another Airlock process owns OAuth token refresh (${provider.store.lockProblem ?? 'writer lock held elsewhere'})`,
    };
  }

  await provider.adoptOrphanedSuccessors();
  const grant = await provider.grant();
  const refreshToken = grant.tokens?.refresh_token;
  if (!refreshToken) return { kind: 'no_grant', reason: 'no refresh token stored' };
  if (!grant.clientInfo) return { kind: 'no_grant', reason: 'no OAuth client registration stored' };
  const clientInfo = grant.clientInfo;

  const known = grant.discovery;
  const storedIssuer = grant.issuer ?? (known ? issuerOf(known) : undefined);
  // An exchange with no definitive answer (ambiguous, or interrupted by a crash): the stored token
  // may already have been rotated there. It is still the only token we have, so present it again,
  // but only to the same endpoint — never fan it out to another issuer.
  const pinned: ExchangeMarker | undefined = grant.exchange
    ? grant.exchange.state === 'in_flight'
      ? { ...grant.exchange, state: 'ambiguous', at: Date.now(), reason: 'exchange interrupted' }
      : grant.exchange
    : undefined;

  const targets: Target[] = [];
  let issuerChange: { from: string; to: string } | undefined;
  if (pinned) {
    log.warn(
      {
        serverId,
        tokenEndpoint: pinned.tokenEndpoint,
        since: new Date(pinned.at ?? pinned.startedAt).toISOString(),
        reason: pinned.reason,
      },
      'Previous OAuth refresh exchange has no definitive answer; retrying the stored refresh token at the same endpoint only'
    );
    targets.push({
      label: 'pinned',
      issuer: pinned.issuer,
      discovery: pinned.discovery,
      resource: pinned.resource,
    });
  } else {
    const live = await liveDiscovery(serverUrl, known, opts.resourceMetadataUrl);
    if (live.state) {
      const liveIssuer = issuerOf(live.state);
      if (storedIssuer && !issuersMatch(storedIssuer, liveIssuer)) {
        issuerChange = { from: storedIssuer, to: liveIssuer };
      }
    } else if (known) {
      log.warn(
        { serverId, problem: live.problem, issuer: issuerOf(known) },
        'OAuth discovery failed; refreshing with the last known-good authorization server metadata'
      );
    }
    // The endpoint that last refreshed (or issued) this grant goes first. A newly advertised
    // endpoint is only tried when that one definitively rejects the grant or is gone.
    if (known) targets.push({ label: 'known-good', issuer: issuerOf(known), discovery: known });
    // Fresh metadata is a separate candidate when it points elsewhere OR changes how the client
    // authenticates there (e.g. client_secret_basic → client_secret_post at the same URL): after an
    // invalid_client with the stored metadata, the fresh one deserves its own attempt.
    if (
      live.state &&
      (!known ||
        tokenEndpoint(known) !== tokenEndpoint(live.state) ||
        authMethods(known) !== authMethods(live.state))
    ) {
      targets.push({ label: 'live', issuer: issuerOf(live.state), discovery: live.state });
    }
    if (targets.length === 0) {
      return {
        kind: 'failed',
        message: `OAuth discovery failed and no known-good discovery is stored (${live.problem ?? 'unknown'})`,
      };
    }
    if (issuerChange) {
      log.warn(
        { serverId, previousIssuer: issuerChange.from, advertisedIssuer: issuerChange.to },
        known
          ? 'OAuth authorization server issuer changed; refreshing at the known-good endpoint first, the new issuer only if that one rejects the grant or is gone'
          : 'OAuth authorization server issuer changed; refreshing against the advertised issuer (stored grant kept)'
      );
    }
  }

  const failures: Array<{ target: Target; err: unknown; cls: ExchangeClass }> = [];
  for (const target of targets) {
    const resource = target.resource ?? resourceFor(serverUrl, grant.resource, target.discovery);
    const endpoint = tokenEndpoint(target.discovery);
    if (provider.closing) {
      // Shutting down: never send a token request that might not get committed.
      return { kind: 'read_only', reason: 'Airlock is shutting down' };
    }
    const exchangeId = randomUUID();
    const marker: ExchangeMarker = {
      state: 'in_flight',
      id: exchangeId,
      startedAt: Date.now(),
      issuer: target.issuer,
      tokenEndpoint: endpoint,
      discovery: target.discovery,
      ...(resource ? { resource } : {}),
    };
    // Fencing + intent: re-verifies the writer lock and durably records the attempt. If either
    // fails, the refresh token is not spent.
    const begun = await provider.beginExchange(marker);
    if (!begun.ok) {
      if (begun.kind === 'read_only') return { kind: 'read_only', reason: begun.message };
      return {
        kind: 'failed',
        message:
          begun.kind === 'conflict'
            ? 'OAuth grant changed on disk before the refresh was sent; retrying with the new grant'
            : `OAuth store not writable; refresh token not spent until storage recovers (${begun.message})`,
        issuer: target.issuer,
        ...(issuerChange ? { issuerChange } : {}),
      };
    }

    const trace: WireTrace = { invoked: false, responded: false };
    let tokens: OAuthTokens;
    try {
      tokens = await refreshAuthorization(target.discovery.authorizationServerUrl, {
        metadata: target.discovery.authorizationServerMetadata,
        clientInformation: clientInfo,
        refreshToken,
        ...(resource ? { resource } : {}),
        fetchFn: tracingFetch(trace),
      });
    } catch (err) {
      const cls = classifyExchange(err, trace);
      failures.push({ target, err, cls });
      log.warn(
        {
          serverId,
          target: target.label,
          issuer: target.issuer,
          tokenEndpoint: endpoint,
          resource,
          error: describeError(err),
          class: cls,
        },
        cls === 'rejected'
          ? 'OAuth issuer rejected the stored refresh grant; keeping it on disk'
          : cls === 'ambiguous'
            ? 'OAuth token refresh may have reached the issuer but the answer was lost; the refresh token may have been rotated'
            : 'OAuth token refresh request failed; keeping the stored grant'
      );
      if (cls === 'ambiguous') {
        await provider.endExchange({
          ...marker,
          state: 'ambiguous',
          startedAt: pinned?.startedAt ?? marker.startedAt,
          at: Date.now(),
          reason: describeError(err),
        });
        break;
      }
      // A definitive answer (or none sent): restore the previous marker (a pinned ambiguity is
      // still unresolved) or clear the in-flight one. A pinned endpoint that is gone/unreachable
      // starts (or continues) the retirement clock.
      if (pinned && (cls === 'gone' || cls === 'not_sent')) {
        const goneSince = pinned.goneSince ?? Date.now();
        await provider.endExchange({ ...pinned, goneSince });
        if (Date.now() - goneSince >= PINNED_ENDPOINT_RETIRED_MS) {
          return {
            kind: 'rejected',
            code: 'endpoint_retired',
            message: `the endpoint of an earlier refresh whose answer was lost (${pinned.tokenEndpoint}) has been gone or unreachable since ${new Date(goneSince).toISOString()}; the stored refresh token cannot be safely presented anywhere else — browser re-authorization required`,
            issuer: pinned.issuer,
            afterAmbiguous: true,
          };
        }
        break;
      }
      await provider.endExchange(pinned ? { ...pinned, goneSince: undefined } : undefined);
      // Only a definitive "no" proves the token was not consumed; then (and when nothing was sent
      // or no endpoint exists there) the next endpoint may be tried. After a 5xx, wait.
      if (!pinned && (cls === 'rejected' || cls === 'not_sent' || cls === 'gone')) continue;
      break;
    }

    // Successful exchange: commit immediately (coherence-checked, fenced, durable).
    const persistence = await provider.commitRefresh(
      tokens,
      { issuer: target.issuer, discovery: target.discovery, ...(resource ? { resource } : {}) },
      {
        refreshToken,
        clientInfo,
        credentials: grant.credentials,
        ...(grant.revision !== undefined ? { revision: grant.revision } : {}),
        exchangeId,
      }
    );
    const migrated = Boolean(issuerChange && target.label === 'live');
    if (persistence === 'handed_off') {
      return {
        kind: 'read_only',
        reason:
          'lost the OAuth writer lock (or a newer grant revision appeared) during a refresh; the successor was parked for the owner to adopt',
      };
    }
    if (persistence === 'pending') {
      return {
        kind: 'unpersisted',
        issuer: target.issuer,
        message: 'refreshed, but the new grant could not be written to disk yet (retrying)',
        ...(issuerChange ? { issuerChange, migrated } : {}),
      };
    }
    if (migrated) {
      log.info(
        { serverId, previousIssuer: issuerChange!.from, newIssuer: issuerChange!.to },
        'OAuth refresh succeeded against the new issuer; grant re-stamped'
      );
    }
    return {
      kind: 'refreshed',
      issuer: target.issuer,
      persistence,
      ...(issuerChange ? { issuerChange, migrated } : {}),
    };
  }

  const ambiguous = failures.some((f) => f.cls === 'ambiguous');
  const rejection = failures.find((f) => f.cls === 'rejected');
  // A rejection is reported as such only when every endpoint rejected the grant or no longer
  // exists; if one was merely unreachable or erroring, the right AS may simply be down.
  if (rejection && failures.every((f) => f.cls === 'rejected' || f.cls === 'gone')) {
    const err = rejection.err as OAuthError;
    return {
      kind: 'rejected',
      code: err.code,
      message: describeError(err),
      issuer: rejection.target.issuer,
      ...(issuerChange ? { issuerChange } : {}),
      ...(pinned ? { afterAmbiguous: true } : {}),
    };
  }
  const reported =
    failures.find((f) => f.cls === 'ambiguous') ??
    failures.find((f) => f.cls !== 'rejected') ??
    failures[0];
  return {
    kind: 'failed',
    message: describeError(reported.err),
    issuer: reported.target.issuer,
    ...(issuerChange ? { issuerChange } : {}),
    ...(ambiguous || pinned ? { ambiguous: true } : {}),
  };
}
