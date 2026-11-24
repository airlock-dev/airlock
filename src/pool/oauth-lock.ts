import { mkdir, open, readFile, rename, unlink, chmod } from 'fs/promises';
import { hostname } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { childLogger } from '../util/logger.js';

const log = childLogger('oauth-lock');

/** Name of the advisory writer lock inside the OAuth store directory. */
export const WRITER_LOCK_FILE = '.writer.lock';
/** How often the holder re-stamps its heartbeat. */
const HEARTBEAT_MS = 30 * 1000;
/** A lock whose holder has not re-stamped for this long is considered abandoned. */
export const STALE_LOCK_MS = 2 * 60 * 1000;

interface LockRecord {
  pid: number;
  hostname: string;
  nonce: string;
  acquiredAt: number;
  heartbeatAt: number;
}

export interface LockHolder {
  pid: number;
  hostname: string;
  acquiredAt: number;
  heartbeatAt: number;
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

/**
 * Advisory single-writer lock for `~/.airlock/oauth`.
 *
 * Only the process holding this lock refreshes, rotates, or otherwise writes OAuth grants. A second
 * Airlock process sharing the directory (the `airlock tools` CLI, a stdio-mode agent, a dashboard
 * probe) reads the token files but never writes them — before this lock existed such a process
 * could run its own refresh, get `invalid_grant` for a token the gateway had just rotated, and
 * delete the gateway's grant.
 *
 * The lock is a small JSON file holding `{pid, hostname, nonce, heartbeatAt}`. It is considered
 * stale (and may be taken over) when its holder is the current pid on this host (a restarted
 * container re-uses pid 1), when the holder pid is gone on this host, or when the heartbeat is
 * older than {@link STALE_LOCK_MS}.
 */
export class OAuthWriterLock {
  private nonce?: string;
  private acquiredAt = 0;
  private heartbeatTimer?: NodeJS.Timeout;
  private acquiring?: Promise<boolean>;
  private readonly path: string;

  constructor(private readonly dir: string) {
    this.path = join(dir, WRITER_LOCK_FILE);
  }

  /** Whether this process currently believes it holds the lock (cheap, no I/O). */
  get held(): boolean {
    return this.nonce !== undefined;
  }

  /**
   * Acquire the lock if it is free or stale; confirm ownership if already held. Returns false when
   * another live process holds it. Never throws.
   */
  async ensure(): Promise<boolean> {
    if (this.acquiring) return this.acquiring;
    this.acquiring = this.ensureInner().finally(() => {
      this.acquiring = undefined;
    });
    return this.acquiring;
  }

  private async ensureInner(): Promise<boolean> {
    try {
      if (this.nonce) {
        const current = await this.read();
        if (current === 'unreadable') return true; // I/O trouble: keep our in-memory claim.
        if (current?.nonce === this.nonce) return true;
        // Someone took the lock over (we were considered stale). Do not fight for it silently.
        log.warn(
          { dir: this.dir, holderPid: current?.pid, holderHost: current?.hostname },
          'OAuth writer lock was taken over by another process; this process is now read-only'
        );
        this.stopHeartbeat();
        this.nonce = undefined;
      }

      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const existing = await this.read();
      if (existing === 'unreadable') return false;
      if (existing && !this.isStale(existing)) return false;

      const record: LockRecord = {
        pid: process.pid,
        hostname: hostname(),
        nonce: randomUUID(),
        acquiredAt: Date.now(),
        heartbeatAt: Date.now(),
      };
      if (existing) {
        log.info(
          { dir: this.dir, previousPid: existing.pid, previousHost: existing.hostname },
          'Taking over stale OAuth writer lock'
        );
        await this.replace(record);
      } else {
        try {
          const handle = await open(this.path, 'wx', 0o600);
          try {
            await handle.writeFile(JSON.stringify(record), 'utf-8');
            await handle.sync();
          } finally {
            await handle.close();
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false; // lost the race
          throw err;
        }
      }
      // Verify: a concurrent takeover may have renamed over us.
      const confirmed = await this.read();
      if (confirmed === 'unreadable' || confirmed?.nonce !== record.nonce) return false;
      this.nonce = record.nonce;
      this.acquiredAt = record.acquiredAt;
      this.startHeartbeat();
      log.info({ dir: this.dir, pid: process.pid }, 'Acquired OAuth writer lock');
      return true;
    } catch (err) {
      log.warn(
        { dir: this.dir, reason: err instanceof Error ? err.message : String(err) },
        'Could not acquire OAuth writer lock'
      );
      return this.nonce !== undefined;
    }
  }

  /** Who holds the lock right now (for status/CLI), or undefined when free/unreadable. */
  async holder(): Promise<LockHolder | undefined> {
    const record = await this.read();
    if (!record || record === 'unreadable' || this.isStale(record)) return undefined;
    return {
      pid: record.pid,
      hostname: record.hostname,
      acquiredAt: record.acquiredAt,
      heartbeatAt: record.heartbeatAt,
    };
  }

  async release(): Promise<void> {
    this.stopHeartbeat();
    if (!this.nonce) return;
    const nonce = this.nonce;
    this.nonce = undefined;
    const current = await this.read();
    if (current !== 'unreadable' && current?.nonce === nonce) {
      await unlink(this.path).catch(() => {});
    }
  }

  private isStale(record: LockRecord): boolean {
    if (record.hostname === hostname()) {
      // Our own pid can only be us (or a dead predecessor that had the same pid, e.g. pid 1 in a
      // restarted container); either way the record does not represent another live writer.
      if (record.pid === process.pid) return true;
      if (!processAlive(record.pid)) return true;
    }
    return Date.now() - record.heartbeatAt > STALE_LOCK_MS;
  }

  private async read(): Promise<LockRecord | undefined | 'unreadable'> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      return 'unreadable';
    }
    try {
      const parsed = JSON.parse(raw) as Partial<LockRecord>;
      if (typeof parsed.pid !== 'number' || typeof parsed.nonce !== 'string') {
        // A corrupt lock is treated as stale: replace it.
        return { pid: -1, hostname: '', nonce: '', acquiredAt: 0, heartbeatAt: 0 };
      }
      return {
        pid: parsed.pid,
        hostname: parsed.hostname ?? '',
        nonce: parsed.nonce,
        acquiredAt: parsed.acquiredAt ?? 0,
        heartbeatAt: parsed.heartbeatAt ?? 0,
      };
    } catch {
      return { pid: -1, hostname: '', nonce: '', acquiredAt: 0, heartbeatAt: 0 };
    }
  }

  private async replace(record: LockRecord): Promise<void> {
    const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(record), 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, this.path);
    await chmod(this.path, 0o600).catch(() => {});
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.beat();
    }, HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private async beat(): Promise<void> {
    if (!this.nonce) return;
    const current = await this.read();
    if (current === 'unreadable') return;
    if (current?.nonce !== this.nonce) {
      // Re-validate (and log) through ensure() on the next write instead of here.
      return;
    }
    await this.replace({
      pid: process.pid,
      hostname: hostname(),
      nonce: this.nonce,
      acquiredAt: this.acquiredAt,
      heartbeatAt: Date.now(),
    }).catch(() => {});
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
