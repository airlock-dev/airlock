import {
  OAuthError,
  OAuthErrorCode,
  checkResourceAllowed,
  discoverOAuthServerInfo,
  refreshAuthorization,
  resourceUrlFromServerUrl,
} from '@modelcontextprotocol/client';
import type { OAuthDiscoveryState, OAuthTokens } from '@modelcontextprotocol/client';
import type { FileOAuthProvider } from './oauth-provider.js';
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

export type RefreshOutcome =
  | { kind: 'refreshed'; issuer?: string; issuerChange?: { from: string; to: string } }
  /** No refresh token stored: only an interactive authorization can produce a grant. */
  | { kind: 'no_grant'; reason: string }
  /** The issuer explicitly rejected the grant (invalid_grant & co). The grant is kept on disk. */
  | {
      kind: 'rejected';
      code: string;
      message: string;
      issuer?: string;
      issuerChange?: { from: string; to: string };
    }
  /** Anything else: network, 5xx, timeout, malformed response, discovery outage. */
  | {
      kind: 'failed';
      message: string;
      issuer?: string;
      issuerChange?: { from: string; to: string };
    }
  /** This process may not write the grant (read-only command, or another process holds the lock). */
  | { kind: 'read_only'; reason: string };

interface Target {
  label: 'live' | 'known-good';
  issuer: string;
  discovery: OAuthDiscoveryState;
}

function issuersMatch(a: string, b: string): boolean {
  const strip = (s: string) => (s.endsWith('/') ? s.slice(0, -1) : s);
  return strip(a) === strip(b);
}

function issuerOf(state: OAuthDiscoveryState): string {
  return state.authorizationServerMetadata?.issuer ?? String(state.authorizationServerUrl);
}

function tokenEndpoint(state: OAuthDiscoveryState): string {
  return (
    state.authorizationServerMetadata?.token_endpoint ??
    new URL('/token', state.authorizationServerUrl).href
  );
}

function describeError(err: unknown): string {
  if (err instanceof OAuthError) return `${err.code}: ${err.message}`.slice(0, 300);
  if (err instanceof Error) return (err.message.split('\n')[0] ?? err.name).slice(0, 300);
  return String(err).slice(0, 300);
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
 * Refresh the stored grant. Single-flight per token file: concurrent proactive and reactive
 * refreshes share one token request, so a rotating refresh token is never spent twice.
 *
 * Never deletes or overwrites the stored grant except with a successful refresh result.
 */
export function refreshGrant(
  provider: FileOAuthProvider,
  serverUrl: string,
  opts: { resourceMetadataUrl?: URL } = {}
): Promise<RefreshOutcome> {
  const key = provider.store.path;
  const existing = inflight.get(key);
  if (existing) return existing;
  const run = doRefresh(provider, serverUrl, opts).finally(() => inflight.delete(key));
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
    return { kind: 'read_only', reason: 'another Airlock process holds the OAuth writer lock' };
  }

  const grant = await provider.grant();
  const refreshToken = grant.tokens?.refresh_token;
  if (!refreshToken) return { kind: 'no_grant', reason: 'no refresh token stored' };
  if (!grant.clientInfo) return { kind: 'no_grant', reason: 'no OAuth client registration stored' };

  const known = grant.discovery;
  const live = await liveDiscovery(serverUrl, known, opts.resourceMetadataUrl);

  // Decide where to send the refresh, in order of preference.
  const targets: Target[] = [];
  let issuerChange: { from: string; to: string } | undefined;
  const storedIssuer = grant.issuer ?? (known ? issuerOf(known) : undefined);
  if (live.state) {
    const liveIssuer = issuerOf(live.state);
    if (storedIssuer && !issuersMatch(storedIssuer, liveIssuer)) {
      issuerChange = { from: storedIssuer, to: liveIssuer };
      log.warn(
        { serverId, previousIssuer: storedIssuer, newIssuer: liveIssuer },
        'OAuth authorization server issuer changed; trying the stored refresh token against the new issuer (stored grant kept)'
      );
    }
    targets.push({ label: 'live', issuer: liveIssuer, discovery: live.state });
    // Fall back to what worked last time when it points somewhere else (previous issuer, or a
    // token endpoint the live metadata no longer advertises).
    if (known && (issuerChange || tokenEndpoint(known) !== tokenEndpoint(live.state))) {
      targets.push({ label: 'known-good', issuer: issuerOf(known), discovery: known });
    }
  } else if (known) {
    log.warn(
      { serverId, problem: live.problem, issuer: issuerOf(known) },
      'OAuth discovery failed; refreshing with the last known-good authorization server metadata'
    );
    targets.push({ label: 'known-good', issuer: issuerOf(known), discovery: known });
  } else {
    return {
      kind: 'failed',
      message: `OAuth discovery failed and no known-good discovery is stored (${live.problem ?? 'unknown'})`,
    };
  }

  const failures: Array<{ target: Target; err: unknown; rejection: boolean }> = [];
  for (const target of targets) {
    const resource = resourceFor(serverUrl, grant.resource, target.discovery);
    let tokens: OAuthTokens;
    try {
      tokens = await refreshAuthorization(target.discovery.authorizationServerUrl, {
        metadata: target.discovery.authorizationServerMetadata,
        clientInformation: grant.clientInfo,
        refreshToken,
        ...(resource ? { resource } : {}),
        fetchFn: oauthFetch,
      });
    } catch (err) {
      const rejection = err instanceof OAuthError && REJECTION_CODES.has(err.code);
      failures.push({ target, err, rejection });
      log.warn(
        {
          serverId,
          target: target.label,
          issuer: target.issuer,
          resource,
          error: describeError(err),
          rejection,
        },
        rejection
          ? 'OAuth issuer rejected the stored refresh grant; keeping it on disk'
          : 'OAuth token refresh request failed; keeping the stored grant'
      );
      // Only an explicit rejection proves the refresh token was not consumed. After a timeout or
      // 5xx the issuer may have rotated it already; presenting it elsewhere could look like reuse
      // (and trip refresh-token family revocation), so wait for the next retry instead.
      if (!rejection) break;
      continue;
    }

    // A refresh response's `resource`-less success at the new issuer is still bound to the new
    // issuer: stamp it, and remember the discovery that worked as known-good.
    await provider.commitRefresh(tokens, {
      issuer: target.issuer,
      discovery: target.discovery,
      ...(resource ? { resource } : {}),
    });
    if (issuerChange && target.label === 'known-good') {
      log.warn(
        { serverId, issuer: target.issuer, advertisedIssuer: issuerChange.to },
        'OAuth refresh succeeded only against the previous issuer; keeping it'
      );
    } else if (issuerChange) {
      log.info(
        { serverId, previousIssuer: issuerChange.from, newIssuer: issuerChange.to },
        'OAuth refresh succeeded against the new issuer; grant re-stamped'
      );
    }
    return {
      kind: 'refreshed',
      issuer: target.issuer,
      ...(issuerChange && target.label === 'live' ? { issuerChange } : {}),
    };
  }

  // Every target failed. Only call it a rejection when every attempt was an explicit rejection;
  // if any target was merely unreachable, the right AS may simply be down.
  const first = failures[0];
  const allRejected = failures.every((f) => f.rejection);
  if (allRejected) {
    const err = first.err as OAuthError;
    return {
      kind: 'rejected',
      code: err.code,
      message: describeError(err),
      issuer: first.target.issuer,
      ...(issuerChange ? { issuerChange } : {}),
    };
  }
  const transient = failures.find((f) => !f.rejection) ?? first;
  return {
    kind: 'failed',
    message: describeError(transient.err),
    issuer: transient.target.issuer,
    ...(issuerChange ? { issuerChange } : {}),
  };
}
