import { chmod, mkdir, readdir, readFile, rename, stat, unlink } from 'fs/promises';
import { createHash, randomUUID } from 'crypto';
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
/** Successors obtained by a process that lost the writer lock mid-exchange (see adoption). */
export const ORPHAN_DIR = '.successors';
/** Operator requests handed to the lock holder (`airlock oauth restore` while a gateway runs). */
export const REQUEST_DIR = '.requests';

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

/**
 * A refresh exchange that was started but has no definitive answer.
 *
 * `in_flight` is written (durably) right before the refresh token is sent and replaced by the
 * successor in the same write that commits it. Found on disk by a later run it means the process
 * stopped mid-exchange. `ambiguous` means the request may have reached the issuer but the response
 * was lost (timeout, connection reset after sending, 502/504): the issuer may already have rotated
 * the refresh token. Either way the stored token is the only one we have, so it is retried, but
 * only at the same endpoint, and the state is reported until a refresh succeeds.
 */
export interface ExchangeMarker {
  state: 'in_flight' | 'ambiguous';
  startedAt: number;
  /** When the exchange became ambiguous. */
  at?: number;
  reason?: string;
  issuer: string;
  tokenEndpoint: string;
  discovery: OAuthDiscoveryState;
  resource?: string;
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
   * Last known-good discovery (PRM + AS metadata) for this grant: the metadata of the endpoint
   * that last refreshed (or issued) it. Refreshes go there first.
   */
  discovery?: OAuthDiscoveryState;
  /** RFC 8707 resource indicator used when the grant was authorized; sent on every refresh. */
  resource?: string;
  pending?: PendingAuthorization;
  exchange?: ExchangeMarker;
  /** Legacy (pre-pending) location of the PKCE verifier. Read-only compatibility. */
  codeVerifier?: string;
}

export class OAuthStoreReadOnlyError extends Error {
  constructor(serverId: string, reason: string) {
    super(`OAuth storage for ${serverId} is read-only in this process (${reason})`);
    this.name = 'OAuthStoreReadOnlyError';
  }
}

/** The grant file changed under this process (operator restore, another writer). */
export class OAuthStoreConflictError extends Error {
  constructor(serverId: string) {
    super(`OAuth grant file for ${serverId} changed on disk since it was read`);
    this.name = 'OAuthStoreConflictError';
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
  /** A refresh exchange without a definitive answer (see {@link ExchangeMarker}). */
  exchange?: { state: 'interrupted' | 'ambiguous'; since: string; tokenEndpoint: string };
  unreadable?: boolean;
}

export function oauthStoreDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.';
  return join(home, '.airlock', 'oauth');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
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
    ...(data.exchange
      ? {
          exchange: {
            state: data.exchange.state === 'in_flight' ? 'interrupted' : 'ambiguous',
            since: new Date(data.exchange.at ?? data.exchange.startedAt).toISOString(),
            tokenEndpoint: data.exchange.tokenEndpoint,
          },
        }
      : {}),
  };
}

/** The part of a file whose loss would force re-authorization. */
function grantFingerprint(data: PersistedGrant): string {
  return JSON.stringify({ c: data.clientInfo ?? null, t: data.tokens ?? null });
}

function sanitizeId(serverId: string): string {
  return serverId.replace(/[^A-Za-z0-9._-]/g, '_');
}

function historyStamp(): string {
  return new Date().toISOString().replace(/[-:.]/g, '');
}

// ─── Per-grant operation serialization ──────────────────────────────────────────────────────────

const grantOps = new Map<string, Promise<void>>();

/**
 * Run `fn` exclusively for one grant file within this process. Refresh exchanges, authorization-
 * code exchanges, orphan adoption, and restores all run through here, so no two of them can
 * interleave their read → network → commit sequences on the same grant.
 */
export async function withGrantOperation<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const previous = grantOps.get(path) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.then(() => mine);
  grantOps.set(path, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (grantOps.get(path) === tail) grantOps.delete(path);
  }
}

export interface OrphanSuccessor {
  file: string;
  savedAt: number;
  /** sha256 of the refresh token that was presented to obtain this successor. */
  predecessor: string;
  grant: PersistedGrant;
}

/**
 * File-level persistence for one provider's OAuth grant: single-writer (fenced by the writer lock),
 * compare-and-swap against the version this process last saw, atomic durable replace, and a
 * rotating backup of every previous grant written *after* the new grant is durable.
 */
export class OAuthGrantStore {
  readonly path: string;
  readonly historyDir: string;
  readonly orphanDir: string;
  private readonly lock: OAuthWriterLock;
  /** Serializes replacements so an older snapshot can never land after a newer one. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Backups run here, after the primary commit, and never delay it. */
  private historyQueue: Promise<void> = Promise.resolve();
  /** sha256 of the last content this store instance wrote. */
  private lastWrittenHash?: string;

  constructor(
    readonly serverId: string,
    readonly mode: OAuthStorageMode = 'writer',
    readonly dir: string = oauthStoreDir()
  ) {
    this.path = join(dir, `${serverId}.json`);
    this.historyDir = join(dir, HISTORY_DIR, sanitizeId(serverId));
    this.orphanDir = join(dir, ORPHAN_DIR, sanitizeId(serverId));
    this.lock = writerLockFor(dir);
    if (mode === 'writer') this.lock.setRequestHandler(processOperatorRequests);
  }

  /** Whether this process may write right now (acquires the writer lock on demand). */
  async canWrite(): Promise<boolean> {
    if (this.mode === 'readonly') return false;
    return this.lock.ensure();
  }

  /** Why the last lock check failed, for outcome messages. */
  get lockProblem(): string | undefined {
    return this.lock.lastProblem;
  }

  /** Read the grant. A missing file is `{}`; an unparseable one is reported, never overwritten. */
  async read(): Promise<{
    data: PersistedGrant;
    raw?: string;
    corrupt?: boolean;
    hash: string | null;
  }> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { data: {}, hash: null };
      throw err;
    }
    try {
      return { data: JSON.parse(raw) as PersistedGrant, raw, hash: sha256(raw) };
    } catch {
      return { data: {}, raw, corrupt: true, hash: sha256(raw) };
    }
  }

  /**
   * Replace the grant file. Requires (and re-verifies) the writer lock immediately before writing.
   *
   * `expectHash` makes it a compare-and-swap: the write is refused with
   * {@link OAuthStoreConflictError} when the file is neither what the caller last read nor what
   * this store last wrote (`null` = expect no file; omit to skip the check, e.g. a restore).
   * The new grant is made durable first (tmp + fsync + rename + dir fsync); the previous version
   * is copied to history afterwards, and a failing backup never fails the write.
   */
  async write(
    data: PersistedGrant,
    reason: string,
    opts: { expectHash?: string | null } = {}
  ): Promise<{ hash: string }> {
    if (this.mode === 'readonly') {
      throw new OAuthStoreReadOnlyError(this.serverId, 'read-only command');
    }
    const snapshot = JSON.stringify(data, null, 2);
    const run = this.queue.then(async () => {
      if (!(await this.lock.ensure())) {
        throw new OAuthStoreReadOnlyError(
          this.serverId,
          this.lock.lastProblem ?? 'another Airlock process holds the writer lock'
        );
      }
      let current: { raw?: string; hash: string | null; data: PersistedGrant; corrupt?: boolean };
      try {
        current = await this.read();
      } catch (err) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      if (
        opts.expectHash !== undefined &&
        current.hash !== opts.expectHash &&
        (this.lastWrittenHash === undefined || current.hash !== this.lastWrittenHash)
      ) {
        throw new OAuthStoreConflictError(this.serverId);
      }
      await atomicWritePrivateFile(this.path, snapshot);
      const hash = sha256(snapshot);
      this.lastWrittenHash = hash;
      this.scheduleBackup(current, data, reason);
      return { hash };
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /** Resolves once every scheduled backup has been written (or failed). */
  async flushHistory(): Promise<void> {
    await this.queue;
    await this.historyQueue;
  }

  private scheduleBackup(
    previous: { raw?: string; data: PersistedGrant; corrupt?: boolean },
    next: PersistedGrant,
    reason: string
  ): void {
    if (previous.raw === undefined) return; // nothing on disk before
    if (!previous.corrupt && grantFingerprint(previous.data) === grantFingerprint(next)) return;
    if (!previous.corrupt && !previous.data.tokens && !previous.data.clientInfo) return;
    // Not awaited: the primary commit is already durable, history must never delay it.
    void this.enqueueHistory(previous.raw, reason);
  }

  /** Keep a copy of an arbitrary grant (e.g. a superseded refresh result) in history. */
  archive(data: PersistedGrant, reason: string): Promise<void> {
    if (this.mode === 'readonly') return Promise.resolve();
    return this.enqueueHistory(JSON.stringify(data, null, 2), reason);
  }

  private enqueueHistory(raw: string, reason: string): Promise<void> {
    const run = this.historyQueue.then(async () => {
      try {
        await mkdir(this.historyDir, { recursive: true, mode: 0o700 });
        await chmod(this.historyDir, 0o700).catch(() => {});
        const stamp = historyStamp();
        let version = `${stamp}-${sanitizeId(reason)}`;
        const existing = new Set(await readdir(this.historyDir).catch(() => [] as string[]));
        for (let i = 1; existing.has(`${version}.json`); i++) {
          version = `${stamp}-${sanitizeId(reason)}-${i}`;
        }
        await atomicWritePrivateFile(join(this.historyDir, `${version}.json`), raw);
        await this.prune();
      } catch (err) {
        log.warn(
          { serverId: this.serverId, reason: err instanceof Error ? err.message : String(err) },
          'Could not back up an OAuth grant version (the current grant is unaffected)'
        );
      }
    });
    this.historyQueue = run;
    return run;
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

  async readBackup(version: string): Promise<PersistedGrant> {
    if (!/^[A-Za-z0-9._-]+$/.test(version)) throw new Error(`Invalid backup version: ${version}`);
    const raw = await readFile(join(this.historyDir, `${version}.json`), 'utf-8');
    return JSON.parse(raw) as PersistedGrant;
  }

  // ─── Orphaned successors ────────────────────────────────────────────────────────────────────

  /**
   * Durably park a successor grant that this process obtained but may not commit (it lost the
   * writer lock during the exchange). The lock holder adopts it (see FileOAuthProvider). Needs no
   * lock: every orphan gets its own file.
   */
  async writeOrphan(grant: PersistedGrant, presentedRefreshToken: string): Promise<string> {
    const file = `${historyStamp()}-${randomUUID()}.json`;
    const body: Omit<OrphanSuccessor, 'file'> = {
      savedAt: Date.now(),
      predecessor: sha256(presentedRefreshToken),
      grant,
    };
    await atomicWritePrivateFile(join(this.orphanDir, file), JSON.stringify(body, null, 2));
    return file;
  }

  async listOrphans(): Promise<OrphanSuccessor[]> {
    let files: string[];
    try {
      files = (await readdir(this.orphanDir)).filter((f) => f.endsWith('.json')).sort();
    } catch {
      return [];
    }
    const out: OrphanSuccessor[] = [];
    for (const file of files) {
      try {
        const parsed = JSON.parse(await readFile(join(this.orphanDir, file), 'utf-8')) as Omit<
          OrphanSuccessor,
          'file'
        >;
        if (typeof parsed.predecessor === 'string' && parsed.grant) out.push({ ...parsed, file });
      } catch {
        // Unreadable orphan: leave it for the operator.
      }
    }
    return out;
  }

  async removeOrphan(file: string): Promise<void> {
    await unlink(join(this.orphanDir, file)).catch(() => {});
  }
}

// ─── Operator restore (serialized with refresh, through the lock holder) ────────────────────────

/** Restore a backup. The caller must hold the writer lock; serialized with refresh/authorization. */
export async function restoreGrant(
  dir: string,
  serverId: string,
  version: string
): Promise<GrantSummary> {
  const store = new OAuthGrantStore(serverId, 'writer', dir);
  return withGrantOperation(store.path, async () => {
    // Staged authorization state and exchange markers belong to the moment the backup was taken,
    // not to the restored grant.
    const { pending: _pending, exchange: _exchange, ...data } = await store.readBackup(version);
    // A restore deliberately replaces whatever is current; the replaced grant goes to history.
    await store.write(data, 'restore');
    await store.flushHistory();
    log.warn({ serverId, version }, 'OAuth grant restored from backup by operator request');
    return summarizeGrant(data);
  });
}

interface OperatorRequest {
  op: 'restore';
  provider: string;
  version: string;
  requestedAt: number;
}

export interface OperatorResult {
  ok: boolean;
  summary?: GrantSummary;
  error?: string;
}

const REQUEST_RE = /^([A-Za-z0-9-]+)\.request\.json$/;

/** Lock-holder side: apply queued operator requests. Runs from the writer lock's poll timer. */
export async function processOperatorRequests(dir: string): Promise<void> {
  const reqDir = join(dir, REQUEST_DIR);
  const names = await readdir(reqDir).catch(() => [] as string[]);
  for (const name of names) {
    const match = REQUEST_RE.exec(name);
    if (!match) continue;
    const id = match[1];
    const claimed = join(reqDir, `${id}.claimed.json`);
    try {
      await rename(join(reqDir, name), claimed); // claim; the CLI cancels by unlinking first
    } catch {
      continue;
    }
    let result: OperatorResult;
    try {
      const request = JSON.parse(await readFile(claimed, 'utf-8')) as OperatorRequest;
      if (request.op !== 'restore' || !request.provider || !request.version) {
        throw new Error('unsupported request');
      }
      const summary = await restoreGrant(dir, request.provider, request.version);
      result = { ok: true, summary };
    } catch (err) {
      result = {
        ok: false,
        error:
          (err as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'backup not found'
            : err instanceof Error
              ? err.message
              : String(err),
      };
    }
    await atomicWritePrivateFile(join(reqDir, `${id}.result.json`), JSON.stringify(result)).catch(
      () => {}
    );
    await unlink(claimed).catch(() => {});
  }
}

/**
 * CLI side: hand a restore to the process holding the writer lock and wait for its answer.
 * Returns undefined when nobody picked the request up in time (the request is withdrawn).
 */
export async function submitRestoreRequest(
  dir: string,
  provider: string,
  version: string,
  waitMs: number
): Promise<OperatorResult | undefined> {
  const reqDir = join(dir, REQUEST_DIR);
  const id = randomUUID();
  const requestPath = join(reqDir, `${id}.request.json`);
  const resultPath = join(reqDir, `${id}.result.json`);
  const request: OperatorRequest = { op: 'restore', provider, version, requestedAt: Date.now() };
  await atomicWritePrivateFile(requestPath, JSON.stringify(request));
  const readResult = async (): Promise<OperatorResult | undefined> => {
    try {
      const result = JSON.parse(await readFile(resultPath, 'utf-8')) as OperatorResult;
      await unlink(resultPath).catch(() => {});
      return result;
    } catch {
      return undefined;
    }
  };
  const poll = async (deadline: number): Promise<OperatorResult | undefined> => {
    while (Date.now() < deadline) {
      const result = await readResult();
      if (result) return result;
      await new Promise((r) => setTimeout(r, 100));
    }
    return readResult();
  };
  const result = await poll(Date.now() + waitMs);
  if (result) return result;
  try {
    await unlink(requestPath); // withdrawn before anyone claimed it
    return undefined;
  } catch {
    // Claimed while we gave up: it is being applied. Wait for the answer.
    return poll(Date.now() + Math.max(waitMs, 30_000));
  }
}
