import { chmod, mkdir, readdir, readFile, stat, unlink } from 'fs/promises';
import { join } from 'path';
import type {
  OAuthClientInformationFull,
  OAuthDiscoveryState,
  OAuthTokens,
} from '@modelcontextprotocol/client';
import { atomicWritePrivateFile } from '../util/atomic-file.js';
import { writerLockFor, type OAuthWriterLock } from './oauth-lock.js';
import { childLogger } from '../util/logger.js';

const log = childLogger('oauth-store');

/** Versions of each provider's grant file kept under `.history/<id>/`. */
export const HISTORY_LIMIT = 10;
export const HISTORY_DIR = '.history';

/**
 * Whether this process may write OAuth grant files.
 *
 * - `writer`: may write when it holds the per-directory writer lock (gateway, stdio agent, the
 *   interactive configure-agent TUI). Without the lock it behaves as `readonly` until it can get it.
 * - `readonly`: never refreshes, writes, or invalidates (`airlock tools`, `lint`, dashboard probes).
 */
export type OAuthStorageMode = 'writer' | 'readonly';

/** An authorization attempt in progress. Never overwrites the stored grant until it succeeds. */
export interface PendingAuthorization {
  startedAt: number;
  clientInfo?: OAuthClientInformationFull;
  codeVerifier?: string;
  discovery?: OAuthDiscoveryState;
  resource?: string;
  issuer?: string;
}

/** On-disk format of `~/.airlock/oauth/<id>.json` (all fields optional for legacy files). */
export interface PersistedGrant {
  clientInfo?: OAuthClientInformationFull;
  tokens?: OAuthTokens;
  /** Wall-clock (ms) when `tokens` were obtained. Drives proactive refresh. */
  obtainedAt?: number;
  /** Issuer of the authorization server that issued `tokens`. */
  issuer?: string;
  /**
   * Last known-good discovery (PRM + AS metadata) for this grant. Refreshes fall back to it when
   * live discovery fails, so an outage of the metadata endpoints never changes where (or with what
   * `resource`) a refresh is sent.
   */
  discovery?: OAuthDiscoveryState;
  /** RFC 8707 resource indicator used when the grant was authorized; sent on every refresh. */
  resource?: string;
  pending?: PendingAuthorization;
  /** Legacy (pre-pending) location of the PKCE verifier. Read-only compatibility. */
  codeVerifier?: string;
}

export class OAuthStoreReadOnlyError extends Error {
  constructor(serverId: string, reason: string) {
    super(`OAuth storage for ${serverId} is read-only in this process (${reason})`);
    this.name = 'OAuthStoreReadOnlyError';
  }
}

export interface HistoryEntry {
  /** Stable identifier for `airlock oauth restore`. */
  version: string;
  savedAt: string;
  reason: string;
  /** Secret-free summary of the backed-up grant. */
  summary: GrantSummary;
}

export interface GrantSummary {
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  hasClientInfo: boolean;
  issuer?: string;
  obtainedAt?: string;
  accessExpiresAt?: string;
  resource?: string;
  hasDiscovery: boolean;
  pendingAuthorization: boolean;
  unreadable?: boolean;
}

export function oauthStoreDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.';
  return join(home, '.airlock', 'oauth');
}

/** The issuer a stored grant belongs to (explicit field, else the SDK's SEP-2352 stamps). */
export function grantIssuer(data: PersistedGrant): string | undefined {
  const stampedTokens = data.tokens as (OAuthTokens & { issuer?: unknown }) | undefined;
  const stampedClient = data.clientInfo as
    | (OAuthClientInformationFull & { issuer?: unknown })
    | undefined;
  if (data.issuer) return data.issuer;
  if (typeof stampedTokens?.issuer === 'string') return stampedTokens.issuer;
  if (typeof stampedClient?.issuer === 'string') return stampedClient.issuer;
  return (
    data.discovery?.authorizationServerMetadata?.issuer ?? data.discovery?.authorizationServerUrl
  );
}

export function summarizeGrant(data: PersistedGrant): GrantSummary {
  const expiresAt =
    data.obtainedAt && data.tokens?.expires_in
      ? new Date(data.obtainedAt + data.tokens.expires_in * 1000).toISOString()
      : undefined;
  return {
    hasAccessToken: Boolean(data.tokens?.access_token),
    hasRefreshToken: Boolean(data.tokens?.refresh_token),
    hasClientInfo: Boolean(data.clientInfo?.client_id),
    issuer: grantIssuer(data),
    obtainedAt: data.obtainedAt ? new Date(data.obtainedAt).toISOString() : undefined,
    accessExpiresAt: expiresAt,
    resource: data.resource,
    hasDiscovery: Boolean(data.discovery),
    pendingAuthorization: Boolean(data.pending),
  };
}

/** The part of a file whose loss would force re-authorization. */
function grantFingerprint(data: PersistedGrant): string {
  return JSON.stringify({ c: data.clientInfo ?? null, t: data.tokens ?? null });
}

function sanitizeId(serverId: string): string {
  return serverId.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * File-level persistence for one provider's OAuth grant: single-writer, atomic replace, and a
 * rotating backup of every previous grant.
 */
export class OAuthGrantStore {
  readonly path: string;
  readonly historyDir: string;
  private readonly lock: OAuthWriterLock;
  /** Serializes replacements so an older snapshot can never land after a newer one. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly serverId: string,
    readonly mode: OAuthStorageMode = 'writer',
    readonly dir: string = oauthStoreDir()
  ) {
    this.path = join(dir, `${serverId}.json`);
    this.historyDir = join(dir, HISTORY_DIR, sanitizeId(serverId));
    this.lock = writerLockFor(dir);
  }

  /** Whether this process may write right now (acquires the writer lock on demand). */
  async canWrite(): Promise<boolean> {
    if (this.mode === 'readonly') return false;
    return this.lock.ensure();
  }

  /** Read the grant. A missing file is `{}`; an unparseable one is reported, never overwritten. */
  async read(): Promise<{ data: PersistedGrant; raw?: string; corrupt?: boolean }> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { data: {} };
      throw err;
    }
    try {
      return { data: JSON.parse(raw) as PersistedGrant, raw };
    } catch {
      return { data: {}, raw, corrupt: true };
    }
  }

  /**
   * Replace the grant file. Requires the writer lock unless `operator` (an explicit CLI restore).
   * The previous file is copied into history first whenever the grant itself changes.
   */
  async write(
    data: PersistedGrant,
    reason: string,
    opts: { operator?: boolean } = {}
  ): Promise<void> {
    if (!opts.operator) {
      if (this.mode === 'readonly') {
        throw new OAuthStoreReadOnlyError(this.serverId, 'read-only command');
      }
      if (!(await this.lock.ensure())) {
        throw new OAuthStoreReadOnlyError(
          this.serverId,
          'another Airlock process holds the writer lock'
        );
      }
    }
    const snapshot = JSON.stringify(data, null, 2);
    const run = this.queue.then(async () => {
      await this.backupCurrent(data, reason);
      await atomicWritePrivateFile(this.path, snapshot);
    });
    this.queue = run.catch(() => {});
    await run;
  }

  private async backupCurrent(next: PersistedGrant, reason: string): Promise<void> {
    let current: { data: PersistedGrant; raw?: string; corrupt?: boolean };
    try {
      current = await this.read();
    } catch {
      return;
    }
    if (current.raw === undefined) return; // nothing on disk yet
    if (!current.corrupt && grantFingerprint(current.data) === grantFingerprint(next)) return;
    if (!current.corrupt && !current.data.tokens && !current.data.clientInfo) return;
    try {
      await mkdir(this.historyDir, { recursive: true, mode: 0o700 });
      await chmod(this.historyDir, 0o700).catch(() => {});
      const stamp = new Date().toISOString().replace(/[-:.]/g, '');
      let version = `${stamp}-${sanitizeId(reason)}`;
      const existing = new Set(await readdir(this.historyDir).catch(() => [] as string[]));
      for (let i = 1; existing.has(`${version}.json`); i++) {
        version = `${stamp}-${sanitizeId(reason)}-${i}`;
      }
      await atomicWritePrivateFile(join(this.historyDir, `${version}.json`), current.raw);
      await this.prune();
    } catch (err) {
      // A failed backup must not block persisting a freshly rotated token: losing that token is
      // strictly worse than missing one history entry.
      log.warn(
        { serverId: this.serverId, reason: err instanceof Error ? err.message : String(err) },
        'Could not back up previous OAuth grant before replacing it'
      );
    }
  }

  private async prune(): Promise<void> {
    const files = (await readdir(this.historyDir)).filter((f) => f.endsWith('.json')).sort();
    const excess = files.length - HISTORY_LIMIT;
    for (let i = 0; i < excess; i++) {
      await unlink(join(this.historyDir, files[i])).catch(() => {});
    }
  }

  /** Newest first. Never returns token values. */
  async history(): Promise<HistoryEntry[]> {
    let files: string[];
    try {
      files = (await readdir(this.historyDir)).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    files.sort().reverse();
    const entries: HistoryEntry[] = [];
    for (const file of files) {
      const version = file.slice(0, -'.json'.length);
      const fullPath = join(this.historyDir, file);
      let summary: GrantSummary;
      try {
        summary = summarizeGrant(JSON.parse(await readFile(fullPath, 'utf-8')) as PersistedGrant);
      } catch {
        summary = {
          hasAccessToken: false,
          hasRefreshToken: false,
          hasClientInfo: false,
          hasDiscovery: false,
          pendingAuthorization: false,
          unreadable: true,
        };
      }
      const savedAt = (await stat(fullPath).catch(() => undefined))?.mtime.toISOString() ?? '';
      const reason = version.split('-').slice(1).join('-');
      entries.push({ version, savedAt, reason, summary });
    }
    return entries;
  }

  /**
   * Explicit operator action: put a backed-up grant back. The grant being replaced is itself
   * backed up first, so a restore can always be undone.
   */
  async restore(version: string): Promise<GrantSummary> {
    if (!/^[A-Za-z0-9._-]+$/.test(version)) throw new Error(`Invalid backup version: ${version}`);
    const raw = await readFile(join(this.historyDir, `${version}.json`), 'utf-8');
    const data = JSON.parse(raw) as PersistedGrant;
    await this.write(data, 'restore', { operator: true });
    return summarizeGrant(data);
  }
}
