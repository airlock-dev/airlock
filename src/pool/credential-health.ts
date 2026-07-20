import type { ClientPool } from './pool.js';
import type { CredentialProbeConfig } from '../config/schema.js';
import { childLogger } from '../util/logger.js';

const log = childLogger('credential-health');

export type CredentialHealthState = 'ok' | 'auth_required' | 'error' | 'unknown';

export interface CredentialHealth {
  status: CredentialHealthState;
  /**
   * Where the verdict came from. `connection` is the transport's own OAuth state (free, and the
   * only signal available for providers Airlock authenticates itself); `probe` is an actual call;
   * `none` means nothing can be said.
   */
  source: 'connection' | 'probe' | 'none';
  reason?: string;
  /** ISO timestamp of the last completed probe. Absent unless source is `probe`. */
  checkedAt?: string;
}

interface CacheEntry extends CredentialHealth {
  /** Epoch ms after which the entry is stale and a background refresh is kicked off on read. */
  expiresAt: number;
}

/**
 * Phrases that mean "this credential is dead", as opposed to "this call went wrong". Matched
 * ONLY against error text (a throw or an `isError` result), never against a successful payload —
 * a probe that returns user data would otherwise trip on the words appearing in that data.
 */
const AUTH_FAILURE_PATTERNS = [
  'invalid_grant',
  'invalid_token',
  'invalid credentials',
  'token has been expired or revoked',
  'token expired',
  'expired credentials',
  'credentials do not contain',
  'reauthenticate',
  're-authenticate',
  'reauthorize',
  're-authorize',
  'authorization required',
  'authentication required',
  'login required',
  'unauthorized',
  'permission denied',
  'forbidden',
  '401',
  '403',
];

function looksLikeAuthFailure(text: string): boolean {
  const haystack = text.toLowerCase();
  return AUTH_FAILURE_PATTERNS.some((pattern) => haystack.includes(pattern));
}

/** Flatten an MCP tool result's text content. Non-text blocks are ignored. */
function extractText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return '';
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) =>
      block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : ''
    )
    .join('\n');
}

function isErrorResult(result: unknown): boolean {
  return Boolean(result && typeof result === 'object' && (result as { isError?: unknown }).isError);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Keep `reason` short enough to sit in a /health payload and a Pushover notification. */
function truncate(text: string, limit = 300): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}

/**
 * Answers "do this provider's credentials still work?" — the question `mcpHealth` cannot answer,
 * because a reachable MCP server and a valid credential are independent facts.
 *
 * Deliberately NOT a scheduler. Results are cached with a per-probe TTL and refreshed lazily on
 * read (stale-while-revalidate), so a caller polling /health every 10s still only spends one real
 * API call per TTL, and never blocks on one. `prime()` runs the first round at startup so the
 * first poll after a restart has real answers instead of `unknown`.
 */
export class CredentialHealthMonitor {
  private cache = new Map<string, CacheEntry>();
  private inFlight = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(
    private pool: ClientPool,
    private probes: Record<string, CredentialProbeConfig>
  ) {}

  /** Run every configured probe once, concurrently. Failures are recorded, never thrown. */
  async prime(): Promise<void> {
    await Promise.allSettled(Object.keys(this.probes).map((id) => this.refresh(id)));
  }

  /**
   * Current verdict for every provider in the pool. Synchronous, to match `pool.healthCheck()`:
   * stale entries are refreshed in the background and land in a later call.
   */
  snapshot(): Record<string, CredentialHealth> {
    const result: Record<string, CredentialHealth> = {};
    for (const id of this.pool.getMcpIds()) {
      result[id] = this.statusFor(id);
    }
    return result;
  }

  private statusFor(id: string): CredentialHealth {
    const connection = this.pool.getProviderConnectionStatus(id);

    // Airlock-held OAuth (providers with `oauth: true`) reports a dead credential through the
    // transport itself. That is a first-class answer and needs no probe.
    if (connection?.status === 'auth_required') {
      return {
        status: 'auth_required',
        source: 'connection',
        ...(connection.reason ? { reason: truncate(connection.reason) } : {}),
      };
    }

    const probe = this.probes[id];
    if (!probe) {
      // No probe, and the transport is not complaining. Transport-up is NOT credential-valid, so
      // say so plainly rather than reporting a green that hasn't been earned.
      return {
        status: 'unknown',
        source: connection ? 'connection' : 'none',
        reason: connection?.status === 'up' ? 'no credential_probe configured' : connection?.reason,
      };
    }

    const cached = this.cache.get(id);
    if (!cached || cached.expiresAt <= Date.now()) {
      void this.refreshInBackground(id);
    }
    if (cached) {
      const { expiresAt: _expiresAt, ...health } = cached;
      return health;
    }
    return { status: 'unknown', source: 'probe', reason: 'probe has not completed yet' };
  }

  private refreshInBackground(id: string): Promise<void> {
    const existing = this.inFlight.get(id);
    if (existing) return existing;
    const run = this.refresh(id).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, run);
    return run;
  }

  private async refresh(id: string): Promise<void> {
    const probe = this.probes[id];
    if (!probe || this.stopped) return;

    const health = await this.runProbe(id, probe);
    if (this.stopped) return;
    this.cache.set(id, { ...health, expiresAt: Date.now() + probe.interval_ms });

    if (health.status !== 'ok') {
      log.warn({ id, status: health.status, reason: health.reason }, 'Credential probe failed');
    }
  }

  private async runProbe(id: string, probe: CredentialProbeConfig): Promise<CredentialHealth> {
    const checkedAt = new Date().toISOString();

    // A provider that is merely disconnected has a transport problem, not a credential problem.
    // Reporting `error` here would double-count what mcpHealth already says.
    if (!this.pool.isReady(id)) {
      const connection = this.pool.getProviderConnectionStatus(id);
      return {
        status: 'unknown',
        source: 'probe',
        reason: truncate(
          `provider not connected: ${connection?.reason ?? connection?.status ?? 'unknown'}`
        ),
        checkedAt,
      };
    }

    let result: unknown;
    try {
      result = await this.withTimeout(
        this.pool.callTool(id, probe.tool, probe.args),
        probe.timeout_ms,
        `credential probe timed out after ${probe.timeout_ms}ms`
      );
    } catch (err) {
      const message = errorMessage(err);
      return {
        status: looksLikeAuthFailure(message) ? 'auth_required' : 'error',
        source: 'probe',
        reason: truncate(message),
        checkedAt,
      };
    }

    const text = extractText(result);

    if (isErrorResult(result)) {
      return {
        status: looksLikeAuthFailure(text) ? 'auth_required' : 'error',
        source: 'probe',
        reason: truncate(text || 'tool returned isError with no message'),
        checkedAt,
      };
    }

    // Providers that report a dead credential as a *successful* text response — the Google
    // Workspace sidecar's "ACTION REQUIRED: authorize…" is the motivating case — can only be
    // caught by the operator telling us what healthy looks like.
    if (probe.expect_contains && !text.includes(probe.expect_contains)) {
      return {
        status: 'auth_required',
        source: 'probe',
        reason: truncate(`response did not contain "${probe.expect_contains}": ${text}`),
        checkedAt,
      };
    }
    if (probe.reject_contains && text.includes(probe.reject_contains)) {
      return {
        status: 'auth_required',
        source: 'probe',
        reason: truncate(`response contained "${probe.reject_contains}"`),
        checkedAt,
      };
    }

    return { status: 'ok', source: 'probe', checkedAt };
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      timer.unref?.();
      promise.then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }

  /** Re-key against a new config. Verdicts for probes that changed are dropped, not carried over. */
  reload(probes: Record<string, CredentialProbeConfig>): void {
    for (const id of Array.from(this.cache.keys())) {
      const next = probes[id];
      if (!next || JSON.stringify(next) !== JSON.stringify(this.probes[id])) {
        this.cache.delete(id);
      }
    }
    this.probes = probes;
  }

  stop(): void {
    this.stopped = true;
    this.cache.clear();
  }
}
