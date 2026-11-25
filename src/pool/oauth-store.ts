import { chmod, link, mkdir, open, readdir, readFile, rename, stat, unlink } from 'fs/promises';
import { createHash, randomUUID } from 'crypto';
import { join, resolve } from 'path';
import type {
  OAuthClientInformationFull,
  OAuthDiscoveryState,
  OAuthTokens,
} from '@modelcontextprotocol/client';
import { atomicWritePrivateFile } from '../util/atomic-file.js';
import { setLockAcquiredHook, writerLockFor, type OAuthWriterLock } from './oauth-lock.js';
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
 * Immutable grant revisions: `.grants/<id>/r<NNNNNNNNNNNN>.json`. The highest readable revision is
 * the grant. `<id>.json` next to it is a compatibility mirror (status tools, `ls`), never read
 * once revisions exist.
 */
export const REVISION_DIR = '.grants';
/** Revisions kept per grant (older ones are pruned after a newer one is durable). */
export const REVISIONS_KEPT = 5;
/** Abandoned operator requests/results and crash-left temp files are removed after these ages. */
const REQUEST_TTL_MS = 10 * 60 * 1000;
const TMP_TTL_MS = 60 * 60 * 1000;

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
  /** Identifies this exchange (orphaned successors carry it). */
  id?: string;
  startedAt: number;
  /** First time the pinned endpoint answered as gone (404/410) or unreachable. */
  goneSince?: number;
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
/** A provider id that cannot be mapped to a file inside the store directory. */
export class OAuthStoreIdError extends Error {
  constructor(serverId: string) {
    super(`Invalid OAuth provider id: ${JSON.stringify(serverId)}`);
    this.name = 'OAuthStoreIdError';
  }
}

/** Whether a provider id maps to a file directly inside `dir` (no separators, no traversal). */
export function isValidProviderId(dir: string, serverId: string): boolean {
  if (!serverId || serverId === '.' || serverId === '..') return false;
  if (/[/\\]/.test(serverId)) return false;
  return resolve(dir, `${serverId}.json`) === join(resolve(dir), `${serverId}.json`);
}

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

// Whoever acquires a store's writer lock removes crash-left temp files there (bounded cleanup).
setLockAcquiredHook((dir) => cleanupStaleTemp(dir));

/**
 * Wait until no grant operation (refresh exchange + commit, code exchange, restore) is running
 * for `path` in this process, up to `timeoutMs`. Returns false on timeout. Used at shutdown, after
 * new exchanges stopped being admitted, so a token request already sent is committed (or its
 * successor parked) before the writer lock is released and the process exits.
 */
export async function drainGrantOperations(timeoutMs: number, path?: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pending = path
      ? grantOps.has(path)
        ? [grantOps.get(path)!]
        : []
      : Array.from(grantOps.values());
    if (pending.length === 0) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(pending),
      new Promise((r) => (timer = setTimeout(r, remaining))),
    ]);
    if (timer) clearTimeout(timer);
  }
}

/** Fingerprint of the credentials a successor was derived from (refresh + access token + client). */
export function credentialFingerprint(data: PersistedGrant): string {
  return sha256(
    JSON.stringify([
      data.tokens?.refresh_token ?? null,
      data.tokens?.access_token ?? null,
      data.clientInfo?.client_id ?? null,
    ])
  );
}

export interface OrphanSuccessor {
  file: string;
  savedAt: number;
  /** sha256 of the refresh token that was presented to obtain this successor. */
  predecessor: string;
  /**
   * {@link credentialFingerprint} of the grant the exchange started from. A successor is adopted
   * only while the stored credentials are still exactly those (marker-only revisions in between
   * do not matter; any credential change does).
   */
  predecessorCredentials?: string;
  /** Revision and exchange id the successor was derived from (diagnostics). */
  predecessorRevision?: number;
  exchangeId?: string;
  grant: PersistedGrant;
}

export interface StoredGrant {
  data: PersistedGrant;
  raw?: string;
  corrupt?: boolean;
  /** Revision number (0 = legacy `<id>.json` or nothing stored). */
  rev: number;
  hash: string | null;
}

function revFile(rev: number): string {
  return `r${String(rev).padStart(12, '0')}.json`;
}

function parseRev(name: string): number | undefined {
  const m = /^r(\d{12})\.json$/.exec(name);
  return m ? Number(m[1]) : undefined;
}

async function fsyncDir(dir: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(dir, 'r');
  } catch {
    return; // platforms that cannot open directories: durability there is best-effort
  }
  try {
    await handle.sync(); // a failing directory fsync is surfaced: the entry may not be durable
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Remove crash-left `*.tmp` files older than an hour (bounded cleanup, run by the lock holder). */
export async function cleanupStaleTemp(dir: string): Promise<void> {
  const dirs = [dir];
  for (const sub of [REVISION_DIR, HISTORY_DIR, ORPHAN_DIR]) {
    const names = await readdir(join(dir, sub)).catch(() => [] as string[]);
    for (const name of names) dirs.push(join(dir, sub, name));
  }
  dirs.push(join(dir, REQUEST_DIR));
  for (const d of dirs) {
    const names = await readdir(d).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith('.tmp')) continue;
      const path = join(d, name);
      const info = await stat(path).catch(() => undefined);
      if (info && Date.now() - info.mtimeMs > TMP_TTL_MS) await unlink(path).catch(() => {});
    }
  }
}

/**
 * Persistence for one provider's OAuth grant.
 *
 * Each committed grant is a new immutable revision file, published with `link()` (exclusive
 * create): exactly one writer can publish revision N, and readers take the highest revision. A
 * writer that was frozen after its ownership check and resumes after a takeover can therefore
 * never replace a newer grant: its publication either fails (`EEXIST`) or lands below the new
 * owner's revisions. Writes are also fenced by the writer lock and compare-and-swap against the
 * revision the caller last read. History backups of a same-lineage predecessor are written after
 * the new revision is durable; replacing a different grant (restore, new authorization, a corrupt
 * file) requires a durable backup first.
 */
export class OAuthGrantStore {
  /** Compatibility mirror `<id>.json` (also the legacy, pre-revision grant file). */
  readonly path: string;
  readonly revisionDir: string;
  readonly historyDir: string;
  readonly orphanDir: string;
  readonly validId: boolean;
  private readonly lock: OAuthWriterLock;
  /** Serializes publications so an older snapshot can never be published after a newer one. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Backups run here, after the primary commit, and never delay it. */
  private historyQueue: Promise<unknown> = Promise.resolve();
  /** Revision this store instance last published. */
  private lastWrittenRev?: number;

  constructor(
    readonly serverId: string,
    readonly mode: OAuthStorageMode = 'writer',
    readonly dir: string = oauthStoreDir()
  ) {
    this.validId = isValidProviderId(dir, serverId);
    this.path = join(dir, `${serverId}.json`);
    this.revisionDir = join(dir, REVISION_DIR, sanitizeId(serverId));
    this.historyDir = join(dir, HISTORY_DIR, sanitizeId(serverId));
    this.orphanDir = join(dir, ORPHAN_DIR, sanitizeId(serverId));
    this.lock = writerLockFor(dir);
    if (mode === 'writer') {
      this.lock.setRequestHandler(processOperatorRequests);
      this.lock.keepAcquiring();
    }
  }

  private assertValidId(): void {
    if (!this.validId) throw new OAuthStoreIdError(this.serverId);
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

  /** Subscribe to "this process just acquired the writer lock". Returns an unsubscribe. */
  onLockAcquired(cb: () => void): () => void {
    return this.lock.onAcquired(cb);
  }

  private async revisions(): Promise<number[]> {
    const names = await readdir(this.revisionDir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return [] as string[];
      throw err;
    });
    return names
      .map(parseRev)
      .filter((r): r is number => r !== undefined)
      .sort((a, b) => b - a);
  }

  /**
   * Read the grant: the highest revision, or the legacy `<id>.json` when no revision exists yet.
   * A missing grant is `{}`; an unparseable one is reported (and backed up before any newer
   * revision is published), never silently replaced.
   */
  async read(): Promise<StoredGrant> {
    this.assertValidId();
    for (let attempt = 0; attempt < 5; attempt++) {
      const revs = await this.revisions();
      if (revs.length === 0) return this.readLegacy();
      let raced = false;
      for (const rev of revs) {
        let raw: string;
        try {
          raw = await readFile(join(this.revisionDir, revFile(rev)), 'utf-8');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            raced = true; // pruned meanwhile: list again
            break;
          }
          throw err;
        }
        if (raw.length === 0) continue; // O_EXCL fallback publication still being written
        try {
          return { data: JSON.parse(raw) as PersistedGrant, raw, rev, hash: sha256(raw) };
        } catch {
          return { data: {}, raw, corrupt: true, rev, hash: sha256(raw) };
        }
      }
      if (!raced) return this.readLegacy();
    }
    throw new Error(`OAuth grant revisions for ${this.serverId} kept changing while reading`);
  }

  private async readLegacy(): Promise<StoredGrant> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { data: {}, rev: 0, hash: null };
      throw err;
    }
    try {
      return { data: JSON.parse(raw) as PersistedGrant, raw, rev: 0, hash: sha256(raw) };
    } catch {
      return { data: {}, raw, corrupt: true, rev: 0, hash: sha256(raw) };
    }
  }

  /** Test seam: runs after the new revision is fsynced and right before it is published. */
  async beforePublish(): Promise<void> {}

  /**
   * Publish a new grant revision. Requires (and re-verifies) the writer lock immediately before.
   *
   * `expectRev` makes it a compare-and-swap: refused with {@link OAuthStoreConflictError} when
   * the current revision is neither what the caller last read nor what this store last published
   * (omit to skip the check, e.g. a restore). Publication itself is exclusive (`link()`), so a
   * stale writer that slipped past every check still cannot replace a newer revision.
   *
   * `backup: 'before'` makes a durable history copy of the current grant a precondition (used
   * when replacing a different grant); the default backs it up afterwards, best-effort.
   */
  async write(
    data: PersistedGrant,
    reason: string,
    opts: { expectRev?: number; backup?: 'before' | 'after' } = {}
  ): Promise<{ rev: number; hash: string }> {
    this.assertValidId();
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
      const current = await this.read();
      if (
        opts.expectRev !== undefined &&
        current.rev !== opts.expectRev &&
        (this.lastWrittenRev === undefined || current.rev !== this.lastWrittenRev)
      ) {
        throw new OAuthStoreConflictError(this.serverId);
      }
      const needsBackup =
        current.raw !== undefined &&
        (current.corrupt ||
          ((current.data.tokens || current.data.clientInfo) &&
            grantFingerprint(current.data) !== grantFingerprint(data)));
      if (needsBackup && (opts.backup === 'before' || current.corrupt)) {
        if (!(await this.enqueueHistory(current.raw!, `replaced-by-${reason}`))) {
          throw new Error('could not durably back up the grant being replaced');
        }
      }
      const rev = current.rev + 1;
      await this.publish(rev, snapshot);
      this.lastWrittenRev = rev;
      await this.writeMirror(rev, snapshot);
      await this.pruneRevisions(rev);
      if (needsBackup && opts.backup !== 'before' && !current.corrupt) {
        // Not awaited: the new revision is already durable; history must never delay it.
        void this.enqueueHistory(current.raw!, reason);
      }
      return { rev, hash: sha256(snapshot) };
    });
    this.queue = run.catch(() => {});
    return run;
  }

  private async publish(rev: number, snapshot: string): Promise<void> {
    await mkdir(this.revisionDir, { recursive: true, mode: 0o700 });
    await chmod(this.revisionDir, 0o700).catch(() => {});
    const target = join(this.revisionDir, revFile(rev));
    const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(snapshot, 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await this.beforePublish();
      try {
        await link(tmp, target);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') throw new OAuthStoreConflictError(this.serverId);
        if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'ENOSYS') {
          throw err;
        }
        await this.publishExclusiveFallback(target, snapshot);
      }
    } finally {
      await unlink(tmp).catch(() => {});
    }
    await fsyncDir(this.revisionDir);
  }

  /** Filesystems without hard links: O_EXCL create (readers skip it while it is empty). */
  private async publishExclusiveFallback(target: string, snapshot: string): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(target, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new OAuthStoreConflictError(this.serverId);
      }
      throw err;
    }
    try {
      await handle.writeFile(snapshot, 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /** Keep `<id>.json` in step for tools that read it. Never authoritative; failures are logged. */
  private async writeMirror(rev: number, snapshot: string): Promise<void> {
    try {
      const top = (await this.revisions())[0];
      if (top !== rev) return; // a newer revision exists; its writer mirrors it
      await atomicWritePrivateFile(this.path, snapshot);
    } catch (err) {
      log.warn(
        { serverId: this.serverId, reason: err instanceof Error ? err.message : String(err) },
        'Could not update the OAuth grant mirror file (the grant revision itself is durable)'
      );
    }
  }

  private async pruneRevisions(latest: number): Promise<void> {
    const revs = await this.revisions().catch(() => [] as number[]);
    for (const rev of revs) {
      if (rev <= latest - REVISIONS_KEPT) {
        await unlink(join(this.revisionDir, revFile(rev))).catch(() => {});
      }
    }
  }

  /** Resolves once every scheduled backup has been written (or failed). */
  async flushHistory(): Promise<void> {
    await this.queue;
    await this.historyQueue;
  }

  /**
   * Durably keep a copy of an arbitrary grant (e.g. a superseded refresh result) in history.
   * Resolves true only when the copy is on disk (file and directory fsynced).
   */
  archive(data: PersistedGrant, reason: string): Promise<boolean> {
    if (this.mode === 'readonly') return Promise.resolve(false);
    return this.enqueueHistory(JSON.stringify(data, null, 2), reason);
  }

  /** Test seam: write one history file (atomic + durable). */
  async writeHistoryFile(path: string, raw: string): Promise<void> {
    await atomicWritePrivateFile(path, raw);
  }

  private enqueueHistory(raw: string, reason: string): Promise<boolean> {
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
        await this.writeHistoryFile(join(this.historyDir, `${version}.json`), raw);
        await this.prune();
        return true;
      } catch (err) {
        log.warn(
          { serverId: this.serverId, reason: err instanceof Error ? err.message : String(err) },
          'Could not back up an OAuth grant version'
        );
        return false;
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
    this.assertValidId();
    if (!/^[A-Za-z0-9._-]+$/.test(version)) throw new Error(`Invalid backup version: ${version}`);
    const raw = await readFile(join(this.historyDir, `${version}.json`), 'utf-8');
    return JSON.parse(raw) as PersistedGrant;
  }

  // ─── Orphaned successors ────────────────────────────────────────────────────────────────────

  /**
   * Durably park a successor grant that this process obtained but may not commit (it lost the
   * writer lock, or its publication lost to a newer revision). The lock holder adopts it (see
   * FileOAuthProvider). Needs no lock: every orphan gets its own file.
   */
  async writeOrphan(
    grant: PersistedGrant,
    basis: {
      presentedRefreshToken: string;
      predecessorCredentials: string;
      predecessorRevision?: number;
      exchangeId?: string;
    }
  ): Promise<string> {
    this.assertValidId();
    const file = `${historyStamp()}-${randomUUID()}.json`;
    const body: Omit<OrphanSuccessor, 'file'> = {
      savedAt: Date.now(),
      predecessor: sha256(basis.presentedRefreshToken),
      predecessorCredentials: basis.predecessorCredentials,
      ...(basis.predecessorRevision !== undefined
        ? { predecessorRevision: basis.predecessorRevision }
        : {}),
      ...(basis.exchangeId ? { exchangeId: basis.exchangeId } : {}),
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

/**
 * Restore a backup. The caller must hold the writer lock; serialized with refresh/authorization.
 * With `expectedRevision`, the restore is refused when the grant moved on since it was requested
 * (so a replayed request can never put an old grant over a later rotation).
 */
export async function restoreGrant(
  dir: string,
  serverId: string,
  version: string,
  opts: { expectedRevision?: number } = {}
): Promise<GrantSummary> {
  if (!isValidProviderId(dir, serverId)) throw new OAuthStoreIdError(serverId);
  const store = new OAuthGrantStore(serverId, 'writer', dir);
  return withGrantOperation(store.path, async () => {
    // Staged authorization state and exchange markers belong to the moment the backup was taken,
    // not to the restored grant.
    const { pending: _pending, exchange: _exchange, ...data } = await store.readBackup(version);
    if (opts.expectedRevision !== undefined) {
      const current = await store.read();
      if (current.rev !== opts.expectedRevision) {
        throw new Error(
          `the grant changed since the restore was requested (revision ${opts.expectedRevision} → ${current.rev}); nothing restored`
        );
      }
    }
    // A restore replaces a possibly valid grant: it must be durably backed up first.
    await store.write(data, 'restore', {
      backup: 'before',
      ...(opts.expectedRevision !== undefined ? { expectRev: opts.expectedRevision } : {}),
    });
    log.warn({ serverId, version }, 'OAuth grant restored from backup by operator request');
    return summarizeGrant(data);
  });
}

interface OperatorRequest {
  op: 'restore';
  /** Same as the request file's id; the result carries it back. */
  id: string;
  provider: string;
  version: string;
  /** Grant revision when the request was made; the restore is refused if it moved on. */
  expectedRevision: number;
  requestedAt: number;
}

export interface OperatorResult {
  id?: string;
  ok: boolean;
  summary?: GrantSummary;
  error?: string;
}

const REQUEST_RE = /^([A-Za-z0-9-]+)\.(request|claimed|result)\.json$/;
const inProgress = new Set<string>();

/**
 * Lock-holder side: apply queued operator requests. Runs from the writer lock's poll timer.
 *
 * Requests a previous holder claimed but never answered (it crashed) are re-processed; the
 * revision check makes that safe (an already-applied restore, or one overtaken by a rotation, is
 * refused rather than re-applied). Requests, claims and results older than 10 minutes expire.
 */
export async function processOperatorRequests(dir: string): Promise<void> {
  const reqDir = join(dir, REQUEST_DIR);
  const names = await readdir(reqDir).catch(() => [] as string[]);
  const results = new Set(
    names
      .map((n) => REQUEST_RE.exec(n))
      .filter((m) => m?.[2] === 'result')
      .map((m) => m![1])
  );
  for (const name of names) {
    const match = REQUEST_RE.exec(name);
    if (!match) continue;
    const [, id, kind] = match;
    const path = join(reqDir, name);
    const info = await stat(path).catch(() => undefined);
    if (!info) continue;
    if (Date.now() - info.mtimeMs > REQUEST_TTL_MS) {
      if (!inProgress.has(id)) await unlink(path).catch(() => {});
      continue;
    }
    if (kind === 'result' || inProgress.has(id)) continue;
    if (kind === 'claimed' && results.has(id)) {
      await unlink(path).catch(() => {});
      continue;
    }
    const claimed = join(reqDir, `${id}.claimed.json`);
    if (kind === 'request') {
      try {
        await rename(path, claimed); // claim; the CLI cancels by unlinking first
      } catch {
        continue;
      }
    }
    inProgress.add(id);
    let result: OperatorResult;
    try {
      const request = JSON.parse(await readFile(claimed, 'utf-8')) as Partial<OperatorRequest>;
      if (
        request.op !== 'restore' ||
        typeof request.provider !== 'string' ||
        typeof request.version !== 'string' ||
        typeof request.expectedRevision !== 'number'
      ) {
        throw new Error('unsupported or malformed request');
      }
      if (!isValidProviderId(dir, request.provider)) throw new OAuthStoreIdError(request.provider);
      const summary = await restoreGrant(dir, request.provider, request.version, {
        expectedRevision: request.expectedRevision,
      });
      result = { id, ok: true, summary };
    } catch (err) {
      result = {
        id,
        ok: false,
        error:
          (err as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'backup not found'
            : err instanceof Error
              ? err.message
              : String(err),
      };
    }
    try {
      await atomicWritePrivateFile(join(reqDir, `${id}.result.json`), JSON.stringify(result));
      await unlink(claimed).catch(() => {});
    } catch {
      // Leave the claim: the next poll (or holder) re-evaluates it; the revision check keeps a
      // re-run from applying twice.
    } finally {
      inProgress.delete(id);
    }
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
  if (!isValidProviderId(dir, provider)) throw new OAuthStoreIdError(provider);
  const reqDir = join(dir, REQUEST_DIR);
  const id = randomUUID();
  const requestPath = join(reqDir, `${id}.request.json`);
  const resultPath = join(reqDir, `${id}.result.json`);
  const expectedRevision = (await new OAuthGrantStore(provider, 'readonly', dir).read()).rev;
  const request: OperatorRequest = {
    op: 'restore',
    id,
    provider,
    version,
    expectedRevision,
    requestedAt: Date.now(),
  };
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
