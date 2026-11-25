import { link, mkdir, open, readdir, readFile, stat, unlink } from 'fs/promises';
import { createHash, randomUUID } from 'crypto';
import { dirname, join } from 'path';
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
/**
 * Immutable grant revisions: `.grants/<id>/r<NNNNNNNNNNNN>.json`. The highest readable revision is
 * the grant. `<id>.json` next to it is a compatibility mirror (status tools, `ls`), never read
 * once revisions exist.
 */
export const REVISION_DIR = '.grants';
/** Revisions kept per grant (older ones are pruned after a newer one is durable). */
export const REVISIONS_KEPT = 5;
/** Crash-left temp files are removed after this age. */
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
/** A provider id that OAuth storage refuses (it would not map to its own files verbatim). */
export class OAuthStoreIdError extends Error {
  constructor(serverId: string) {
    super(
      `OAuth provider id ${JSON.stringify(serverId)} is not supported for OAuth grant storage (use letters, digits, ".", "_", "-"; not starting with ".")`
    );
    this.name = 'OAuthStoreIdError';
  }
}

/**
 * Provider ids are used verbatim in every OAuth path (`<id>.json`, `.grants/<id>/`, …), so only
 * ids that are already safe file names are accepted. No encoding, so no two ids can collide.
 */
export const OAUTH_PROVIDER_ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

export function isValidProviderId(serverId: string): boolean {
  return OAUTH_PROVIDER_ID_RE.test(serverId) && serverId.length <= 200;
}

/** The filesystem cannot provide the guarantees OAuth storage relies on (hard links). */
export class OAuthStoreUnsupportedError extends Error {
  constructor(reason: string) {
    super(`OAuth store directory is unsupported: ${reason}; no refresh token will be spent`);
    this.name = 'OAuthStoreUnsupportedError';
  }
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
setLockAcquiredHook(async (dir) => {
  await cleanupStaleTemp(dir);
  await repairMirrors(dir);
});

/** On acquiring the lock (e.g. at startup), bring every `<id>.json` mirror up to date. */
async function repairMirrors(dir: string): Promise<void> {
  const ids = await readdir(join(dir, REVISION_DIR)).catch(() => [] as string[]);
  for (const id of ids) {
    if (isValidProviderId(id)) await new OAuthGrantStore(id, 'writer', dir).repairMirror();
  }
}

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

/** fsync a directory so entries created/renamed in it survive a crash. Errors propagate. */
export async function fsyncDir(dir: string): Promise<void> {
  if (process.platform === 'win32') return; // directories cannot be opened there
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Create `target` (and missing parents below `root`) with mode 0700, fsyncing the parent of every
 * directory created so the new entries are durable before anything is written inside them.
 */
export async function mkdirDurable(root: string, target: string): Promise<void> {
  const chain: string[] = [];
  for (let d = target; d !== root && d.startsWith(root); d = dirname(d)) chain.unshift(d);
  await mkdir(root, { recursive: true, mode: 0o700 });
  // Always fsync the parents, also when the directories already exist: a previous attempt may
  // have created one and then failed its parent fsync. Directory fsyncs are cheap.
  await fsyncDir(dirname(root));
  for (const d of chain) {
    try {
      await mkdir(d, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    await fsyncDir(dirname(d));
  }
}

/** Remove crash-left `*.tmp` files older than an hour (bounded cleanup, run by the lock holder). */
export async function cleanupStaleTemp(dir: string): Promise<void> {
  const dirs = [dir];
  for (const sub of [REVISION_DIR, HISTORY_DIR, ORPHAN_DIR]) {
    const names = await readdir(join(dir, sub)).catch(() => [] as string[]);
    for (const name of names) dirs.push(join(dir, sub, name));
  }
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
    this.validId = isValidProviderId(serverId);
    // Verbatim (validated) id everywhere: no encoding, no collisions between providers.
    const safe = this.validId ? serverId : '_invalid_';
    this.path = join(dir, `${safe}.json`);
    this.revisionDir = join(dir, REVISION_DIR, safe);
    this.historyDir = join(dir, HISTORY_DIR, safe);
    this.orphanDir = join(dir, ORPHAN_DIR, safe);
    this.lock = writerLockFor(dir);
    if (mode === 'writer') this.lock.keepAcquiring();
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
      await this.repairMirror();
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
    await mkdirDurable(this.dir, this.revisionDir);
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
        // The revision appears complete and exactly once, or not at all.
        await link(tmp, target);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') throw new OAuthStoreConflictError(this.serverId);
        if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'ENOSYS') {
          throw new OAuthStoreUnsupportedError(`hard links are not supported (${code})`);
        }
        throw err;
      }
    } finally {
      await unlink(tmp).catch(() => {});
    }
    await fsyncDir(this.revisionDir);
  }

  /**
   * Rollback step (gateway stopped, writer lock held): write the newest revision to `<id>.json`
   * so an older Airlock reads the current grant, and verify it.
   */
  async exportLegacy(): Promise<{ rev: number; exported: boolean }> {
    this.assertValidId();
    const current = await this.read();
    if (current.rev === 0 || current.raw === undefined) return { rev: 0, exported: false };
    await this.writeMirrorFile(this.path, current.raw);
    if ((await readFile(this.path, 'utf-8')) !== current.raw) {
      throw new Error(`verification of ${this.path} failed`);
    }
    return { rev: current.rev, exported: true };
  }

  /**
   * Roll-forward step, run explicitly by the operator (gateway stopped, writer lock held), and
   * only after an older Airlock actually ran against this store: publish `<id>.json` as the newest
   * revision. This PROMOTES the legacy file over newer revisions (the superseded revision is backed
   * up first). Never automatic.
   */
  async importLegacy(): Promise<{ rev: number }> {
    this.assertValidId();
    const raw = await readFile(this.path, 'utf-8');
    const data = JSON.parse(raw) as PersistedGrant;
    return this.write(data, 'import-legacy', { backup: 'before' });
  }

  /** Test seam: write the `<id>.json` mirror. */
  async writeMirrorFile(path: string, raw: string): Promise<void> {
    await atomicWritePrivateFile(path, raw);
  }

  /**
   * Make `<id>.json` equal to the newest revision if it is not (after each publish, and when a
   * process acquires the writer lock). The mirror is a convenience copy for tools: it is never
   * read once revisions exist and never blocks anything; failures are only logged.
   */
  async repairMirror(): Promise<void> {
    try {
      const top = await this.read();
      if (top.rev === 0 || top.raw === undefined) return;
      const mirror = await readFile(this.path, 'utf-8').catch(() => undefined);
      if (mirror === top.raw) return;
      await this.writeMirrorFile(this.path, top.raw);
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
        await mkdirDurable(this.dir, this.historyDir);
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
    await mkdirDurable(this.dir, this.orphanDir);
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

// ─── Operator restore ───────────────────────────────────────────────────────────────────────────

/**
 * Restore a backup. The caller must hold the writer lock (`airlock oauth restore` takes it, so a
 * restore only runs while no gateway owns the store, or after an explicit `--force` takeover).
 * Serialized with refresh/authorization in this process.
 */
export async function restoreGrant(
  dir: string,
  serverId: string,
  version: string
): Promise<GrantSummary> {
  if (!isValidProviderId(serverId)) throw new OAuthStoreIdError(serverId);
  const store = new OAuthGrantStore(serverId, 'writer', dir);
  return withGrantOperation(store.path, async () => {
    // Staged authorization state and exchange markers belong to the moment the backup was taken,
    // not to the restored grant.
    const { pending: _pending, exchange: _exchange, ...data } = await store.readBackup(version);
    // A restore replaces a possibly valid grant: it must be durably backed up first.
    await store.write(data, 'restore', { backup: 'before' });
    log.warn({ serverId, version }, 'OAuth grant restored from backup by operator request');
    return summarizeGrant(data);
  });
}
