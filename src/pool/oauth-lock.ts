import { readFileSync, readlinkSync } from 'fs';
import { link, mkdir, open, readdir, readFile, rename, unlink } from 'fs/promises';
import { hostname, uptime } from 'os';
import { join } from 'path';
import { performance } from 'perf_hooks';
import { randomUUID } from 'crypto';
import { childLogger } from '../util/logger.js';

const log = childLogger('oauth-lock');

/**
 * Generation files of the writer lock inside the OAuth store directory: `.writer.lock.<gen>`. The
 * highest existing generation is the lock; each takeover creates the next generation exclusively.
 */
export const WRITER_LOCK_PREFIX = '.writer.lock.';
/** Pre-generation lock file (earlier builds). Read as generation 0; removed by the next owner. */
export const LEGACY_WRITER_LOCK_FILE = '.writer.lock';

interface LockTimings {
  /** How often the holder re-stamps its record. */
  heartbeatMs: number;
  /**
   * A record must be observed UNCHANGED for this long (on the observer's monotonic clock) before
   * it may be taken over. Wall-clock timestamps are never compared across processes.
   */
  staleMs: number;
  /**
   * After taking over a record whose holder might still be alive, wait this long before the first
   * write. It outlasts any token request the previous holder could have had in flight.
   */
  takeoverGraceMs: number;
}

const DEFAULT_TIMINGS: LockTimings = {
  heartbeatMs: 30_000,
  staleMs: 2 * 60_000,
  // Two full OAuth request timeouts (15 s each) plus slack.
  takeoverGraceMs: 35_000,
};
let timings: LockTimings = { ...DEFAULT_TIMINGS };

/** Test hook: shorten lock timings. Call with no argument to restore the defaults. */
export function setWriterLockTimings(overrides?: Partial<LockTimings>): void {
  timings = { ...DEFAULT_TIMINGS, ...(overrides ?? {}) };
}

export const STALE_LOCK_MS = DEFAULT_TIMINGS.staleMs;

interface LockRecord {
  pid: number;
  hostname: string;
  /** hostname | boot id | pid namespace. Pids are only comparable when this matches. */
  ns?: string;
  nonce: string;
  gen: number;
  acquiredAt: number;
  heartbeatAt: number;
  released?: boolean;
}

export interface LockHolder {
  pid: number;
  hostname: string;
  gen: number;
  acquiredAt: number;
  heartbeatAt: number;
}

interface Observed {
  gen: number;
  file: string;
  raw: string;
  record?: LockRecord;
}

let cachedNamespace: string | undefined;

/** Identity of the pid space this process lives in: same host, same boot, same pid namespace. */
export function lockNamespace(): string {
  if (cachedNamespace) return cachedNamespace;
  let boot: string;
  let pidns: string;
  try {
    boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim();
  } catch {
    boot = `boot~${Math.round((Date.now() / 1000 - uptime()) / 60)}`;
  }
  try {
    pidns = readlinkSync('/proc/self/ns/pid');
  } catch {
    pidns = process.platform;
  }
  cachedNamespace = `${hostname()}|${boot}|${pidns}`;
  return cachedNamespace;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists but belongs to someone else: still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function genFile(gen: number): string {
  return `${WRITER_LOCK_PREFIX}${String(gen).padStart(12, '0')}`;
}

function parseGen(name: string): number | undefined {
  if (name === LEGACY_WRITER_LOCK_FILE) return 0;
  if (!name.startsWith(WRITER_LOCK_PREFIX)) return undefined;
  const suffix = name.slice(WRITER_LOCK_PREFIX.length);
  return /^\d{1,15}$/.test(suffix) ? Number(suffix) : undefined;
}

function parseRecord(raw: string, gen: number): LockRecord | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<LockRecord>;
    if (typeof parsed.pid !== 'number' || typeof parsed.nonce !== 'string') return undefined;
    return {
      pid: parsed.pid,
      hostname: parsed.hostname ?? '',
      ...(typeof parsed.ns === 'string' ? { ns: parsed.ns } : {}),
      nonce: parsed.nonce,
      gen,
      acquiredAt: parsed.acquiredAt ?? 0,
      heartbeatAt: parsed.heartbeatAt ?? 0,
      ...(parsed.released ? { released: true } : {}),
    };
  } catch {
    return undefined;
  }
}

// Deliberately NOT unref'd: an awaited wait (the takeover grace) must keep a short-lived process
// such as `airlock oauth restore --force` alive until it is over.
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type AcquiredHook = (dir: string) => Promise<void>;
let acquiredHook: AcquiredHook | undefined;

/** Run once each time a process acquires a lock (bounded cleanup of crash leftovers). */
export function setLockAcquiredHook(hook: AcquiredHook): void {
  acquiredHook = hook;
}

/**
 * Single-writer lock for an OAuth store directory (`~/.airlock/oauth`).
 *
 * Only the holder refreshes, rotates, or otherwise writes OAuth grants. Other Airlock processes
 * sharing the directory (`airlock tools`, `lint`, a stdio agent while the gateway runs, the next
 * container during a recreate) read the token files but never write them.
 *
 * Design (no native addon, so no flock/fcntl):
 *
 * - **Atomic takeover.** The lock is the highest-numbered `.writer.lock.<gen>` file. Acquiring or
 *   taking over creates generation `top + 1` with `link()` (hard links are required; without them the lock fails closed), which exactly
 *   one process can win. A process owns the lock iff its generation is the highest present and the
 *   file carries its nonce, so two processes can never both pass the ownership check. Heartbeats
 *   rewrite only the holder's own generation file and so can never overwrite a newer owner.
 * - **Clock-independent staleness.** A record is abandoned only when (a) it was released, (b) its
 *   pid is provably dead (same host, same boot, same pid namespace), or (c) an observer saw the
 *   record's bytes unchanged for {@link LockTimings.staleMs} on its own monotonic clock. Wall-clock
 *   values are display-only, so clock jumps on either side cannot make a live writer look stale.
 * - **Fencing.** {@link verify} is called (through the store) immediately before every token
 *   request and again before committing its result. It renews the heartbeat when the last
 *   successful one is older than one heartbeat interval, so at the moment a request leaves, the
 *   holder's record has been fresh for at least `staleMs - heartbeatMs` more. A process that takes
 *   over a possibly-live holder then waits {@link LockTimings.takeoverGraceMs} (longer than any
 *   token request may run) before its first write.
 *
 * Publication is fenced independently: grants are immutable revision files created exclusively
 * (see OAuthGrantStore), so a frozen holder that resumes after a takeover can never replace the
 * new owner's grant, even if it was suspended right before publishing.
 *
 * Residual assumption: a holder that is frozen (SIGSTOP, VM pause, a blocked event loop) for longer
 * than `staleMs - heartbeatMs + takeoverGraceMs` (~125 s) *between* its fencing check and the moment
 * its token request leaves the host could still send after a new owner has started. Without an
 * issuer-side fencing token this cannot be closed client-side. If such a frozen holder later gets a
 * response, its publication fails and it parks the successor for the new owner to adopt.
 */
export class OAuthWriterLock {
  private nonce?: string;
  private gen = 0;
  private acquiredAt = 0;
  /** Monotonic time at which the last successful heartbeat write started. */
  private lastBeatMono = 0;
  private heartbeatTimer?: NodeJS.Timeout;
  private acquireTimer?: NodeJS.Timeout;
  private readonly acquiredListeners = new Set<() => void>();
  private acquiring?: Promise<boolean>;
  /** What this process saw as the current lock, and since when (monotonic), for staleness. */
  private observation?: { key: string; since: number };
  /** Why the last ensure()/verify() returned false (for status output). */
  lastProblem?: string;

  constructor(private readonly dir: string) {}

  /** Whether this process currently believes it holds the lock (cheap, no I/O). */
  get held(): boolean {
    return this.nonce !== undefined;
  }

  /** Subscribe to "this process just acquired the lock". Returns an unsubscribe function. */
  onAcquired(cb: () => void): () => void {
    this.acquiredListeners.add(cb);
    return () => this.acquiredListeners.delete(cb);
  }

  /**
   * Writer processes keep trying to acquire the lock in the background (every heartbeat interval)
   * whenever they do not hold it. Staleness observation therefore starts at process start, which
   * bounds a takeover after a crashed holder to `staleMs + heartbeatMs + takeoverGraceMs`.
   */
  keepAcquiring(): void {
    if (this.acquireTimer) return;
    const tick = () => {
      if (!this.nonce && !this.acquiring) void this.ensure();
    };
    this.acquireTimer = setInterval(tick, timings.heartbeatMs);
    this.acquireTimer.unref?.();
    tick();
  }

  /** Stop background acquisition (shutdown). */
  stopAcquiring(): void {
    if (this.acquireTimer) clearInterval(this.acquireTimer);
    this.acquireTimer = undefined;
  }

  /**
   * Acquire the lock if it is free or abandoned; when already held, re-verify ownership (fencing
   * check). Returns false when another process holds it or ownership cannot be proven. Never throws.
   */
  ensure(): Promise<boolean> {
    return this.single(() => (this.nonce ? this.verifyInner() : this.acquireInner(false)));
  }

  /** Fencing check only: true iff this process holds the lock right now. Never acquires. */
  verify(): Promise<boolean> {
    return this.single(() => (this.nonce ? this.verifyInner() : Promise.resolve(false)));
  }

  /**
   * Take the lock over even from a live holder (operator `--force`). The previous holder becomes
   * read-only at its next fencing check; this process still waits out the takeover grace period.
   */
  forceAcquire(): Promise<boolean> {
    return this.single(() => (this.nonce ? this.verifyInner() : this.acquireInner(true)));
  }

  private single(fn: () => Promise<boolean>): Promise<boolean> {
    if (this.acquiring) return this.acquiring;
    this.acquiring = fn()
      .catch((err: unknown) => {
        this.lastProblem = err instanceof Error ? err.message : String(err);
        log.warn({ dir: this.dir, reason: this.lastProblem }, 'OAuth writer lock check failed');
        return false;
      })
      .finally(() => {
        this.acquiring = undefined;
      });
    return this.acquiring;
  }

  /** Who holds the lock right now (for status/CLI), or undefined when free/released/unreadable. */
  async holder(): Promise<LockHolder | undefined> {
    const top = await this.top();
    if (!top || top === 'unreadable' || !top.record || top.record.released) return undefined;
    const r = top.record;
    return {
      pid: r.pid,
      hostname: r.hostname,
      gen: top.gen,
      acquiredAt: r.acquiredAt,
      heartbeatAt: r.heartbeatAt,
    };
  }

  /** Release (mark the generation released so the next process can take it at once). */
  async release(): Promise<void> {
    this.stopAcquiring();
    this.stopTimers();
    if (!this.nonce) return;
    const nonce = this.nonce;
    this.nonce = undefined;
    const top = await this.top();
    if (top === 'unreadable' || !top || top.gen !== this.gen || top.record?.nonce !== nonce) return;
    await this.writeOwn({ ...this.record(nonce), released: true }).catch(() => {});
  }

  // ─── internals ────────────────────────────────────────────────────────────────────────────────

  private record(nonce: string): LockRecord {
    return {
      pid: process.pid,
      hostname: hostname(),
      ns: lockNamespace(),
      nonce,
      gen: this.gen,
      acquiredAt: this.acquiredAt,
      heartbeatAt: Date.now(),
    };
  }

  /** The highest generation present, re-listing when a file vanishes between readdir and read. */
  private async top(): Promise<Observed | undefined | 'unreadable'> {
    for (let attempt = 0; attempt < 5; attempt++) {
      let names: string[];
      try {
        names = await readdir(this.dir);
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : 'unreadable';
      }
      let best: { gen: number; file: string } | undefined;
      for (const name of names) {
        const gen = parseGen(name);
        if (gen === undefined) continue;
        if (!best || gen > best.gen) best = { gen, file: name };
      }
      if (!best) return undefined;
      let raw: string;
      try {
        raw = await readFile(join(this.dir, best.file), 'utf-8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        return 'unreadable';
      }
      return { ...best, raw, record: parseRecord(raw, best.gen) };
    }
    return 'unreadable';
  }

  /**
   * Whether the observed top record may be replaced: 'free' (released or provably dead), 'stale'
   * (unchanged for staleMs on our monotonic clock; its holder might merely be frozen), or 'live'.
   */
  private judge(top: Observed): 'free' | 'stale' | 'live' {
    const r = top.record;
    if (r?.released) return 'free';
    if (r?.ns && r.ns === lockNamespace()) {
      if (r.pid === process.pid || !processAlive(r.pid)) return 'free';
    }
    const key = `${top.gen}\n${top.raw}`;
    const now = performance.now();
    if (this.observation?.key !== key) {
      this.observation = { key, since: now };
      return 'live';
    }
    return now - this.observation.since >= timings.staleMs ? 'stale' : 'live';
  }

  private async acquireInner(force: boolean): Promise<boolean> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const top = await this.top();
    if (top === 'unreadable') {
      this.lastProblem = 'writer lock is unreadable';
      return false;
    }
    let grace = false;
    if (top) {
      const verdict = this.judge(top);
      if (verdict === 'live' && !force) {
        this.lastProblem = `held by pid ${top.record?.pid ?? '?'} on ${top.record?.hostname ?? '?'}`;
        return false;
      }
      grace = verdict !== 'free';
      if (verdict !== 'free') {
        log.warn(
          {
            dir: this.dir,
            previousPid: top.record?.pid,
            previousHost: top.record?.hostname,
            forced: force,
          },
          force
            ? 'Forcibly taking over the OAuth writer lock'
            : 'Taking over an OAuth writer lock whose holder stopped heartbeating'
        );
      }
    }

    const gen = (top?.gen ?? 0) + 1;
    const nonce = randomUUID();
    const startedMono = performance.now();
    this.gen = gen;
    this.acquiredAt = Date.now();
    const record = this.record(nonce);
    if (!(await this.createExclusive(gen, record))) {
      this.lastProblem = 'lost the race for the writer lock';
      return false;
    }
    // Ownership is "highest generation carries my nonce". Confirm nobody created a higher one.
    const confirmed = await this.top();
    if (confirmed === 'unreadable' || !confirmed || confirmed.gen !== gen) {
      this.lastProblem = 'lost the race for the writer lock';
      return false;
    }
    if (confirmed.record?.nonce !== nonce) {
      this.lastProblem = 'lost the race for the writer lock';
      return false;
    }
    this.nonce = nonce;
    this.lastBeatMono = startedMono;
    this.observation = undefined;
    this.startHeartbeat();
    await this.cleanupBelow(gen);
    if (grace && timings.takeoverGraceMs > 0) {
      // The previous holder might be frozen mid token request. Let any such request finish (or
      // time out) before this process sends one of its own.
      log.info(
        { dir: this.dir, graceMs: timings.takeoverGraceMs },
        'Waiting out the takeover grace period before writing OAuth grants'
      );
      await sleep(timings.takeoverGraceMs);
      if (!(await this.checkOwnership())) return false;
    }
    log.info({ dir: this.dir, pid: process.pid, gen }, 'Acquired OAuth writer lock');
    this.lastProblem = undefined;
    if (acquiredHook) {
      const hook = acquiredHook;
      void hook(this.dir).catch(() => {});
    }
    for (const listener of this.acquiredListeners) {
      try {
        listener();
      } catch {
        // listeners must not break acquisition
      }
    }
    return true;
  }

  private async verifyInner(): Promise<boolean> {
    if (performance.now() - this.lastBeatMono >= timings.heartbeatMs) {
      if (!(await this.beat())) return false;
    }
    return this.checkOwnership();
  }

  private async checkOwnership(): Promise<boolean> {
    if (!this.nonce) return false;
    const top = await this.top();
    if (top === 'unreadable') {
      // Cannot prove ownership: refuse to write (or spend a refresh token) until we can.
      this.lastProblem = 'writer lock is unreadable';
      return false;
    }
    if (top && top.gen === this.gen && top.record?.nonce === this.nonce) return true;
    this.lost(top);
    return false;
  }

  private lost(top: Observed | undefined): void {
    log.warn(
      { dir: this.dir, holderPid: top?.record?.pid, holderHost: top?.record?.hostname },
      'OAuth writer lock was taken over by another process; this process is now read-only'
    );
    this.lastProblem = 'writer lock was taken over by another process';
    this.stopTimers();
    this.nonce = undefined;
  }

  /** Create a generation file with its full content via link(), failing if it already exists. */
  private async createExclusive(gen: number, record: LockRecord): Promise<boolean> {
    const path = join(this.dir, genFile(gen));
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(record), 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(tmp, path);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return false;
      if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'ENOSYS') {
        // No exclusive publication without hard links: fail closed (never write, never refresh).
        throw new Error(`the OAuth store filesystem does not support hard links (${code})`, {
          cause: err,
        });
      }
      throw err;
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }

  /** Atomically rewrite this process's own generation file (never another generation's). */
  private async writeOwn(record: LockRecord): Promise<void> {
    const path = join(this.dir, genFile(this.gen));
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(record), 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(tmp, path);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }

  private async cleanupBelow(gen: number): Promise<void> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    for (const name of names) {
      const g = parseGen(name);
      if (g !== undefined && g < gen) await unlink(join(this.dir, name)).catch(() => {});
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      // Not routed through single(): a heartbeat must keep running while an acquisition waits out
      // its takeover grace period. Concurrent beats only ever rewrite our own generation file.
      void this.beat().catch(() => {});
    }, timings.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  private stopTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  /** Re-stamp our own generation, after confirming it is still the lock. */
  private async beat(): Promise<boolean> {
    if (!this.nonce) return false;
    const started = performance.now();
    if (!(await this.checkOwnership())) return false;
    try {
      await this.writeOwn(this.record(this.nonce));
    } catch (err) {
      this.lastProblem = `could not write heartbeat: ${err instanceof Error ? err.message : String(err)}`;
      return false;
    }
    this.lastBeatMono = started;
    await this.cleanupBelow(this.gen);
    return true;
  }
}

const locks = new Map<string, OAuthWriterLock>();

/** One lock object per directory per process, shared by every provider in that process. */
export function writerLockFor(dir: string): OAuthWriterLock {
  let lock = locks.get(dir);
  if (!lock) {
    lock = new OAuthWriterLock(dir);
    locks.set(dir, lock);
  }
  return lock;
}

/** Release every lock this process holds (shutdown). */
export async function releaseAllWriterLocks(): Promise<void> {
  await Promise.allSettled(Array.from(locks.values()).map((lock) => lock.release()));
}
