/**
 * A separate OS process contending for the OAuth writer lock (run with `node --import tsx`).
 * Used by oauth-lifecycle.test.ts; prints one JSON line per event on stdout.
 *
 *   race <dir> <staleMs>   observe the current lock, wait until it is stale, wait for <dir>/go,
 *                          then try to take it over and report; re-verify after a second.
 *   paused <dir>           acquire, wait for <dir>/go, fencing check ("send"), wait for
 *                          <dir>/commit, fencing check again ("commit").
 */
import { existsSync } from 'fs';
import { join } from 'path';
import { setWriterLockTimings, writerLockFor } from '../../src/pool/oauth-lock.js';

const [mode, dir, staleArg] = process.argv.slice(2);
const emit = (event: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify({ pid: process.pid, ...event })}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (file: string) => {
  while (!existsSync(join(dir, file))) await sleep(5);
};

async function main(): Promise<void> {
  if (mode === 'race') {
    const staleMs = Number(staleArg);
    setWriterLockTimings({ staleMs, takeoverGraceMs: 0, heartbeatMs: 60_000 });
    const lock = writerLockFor(dir);
    emit({ event: 'observed', acquired: await lock.ensure() });
    await sleep(staleMs + 100);
    await waitFor('go');
    const acquired = await lock.ensure();
    emit({ event: 'raced', acquired });
    await sleep(1000);
    emit({ event: 'verified', owner: await lock.verify() });
    return;
  }
  if (mode === 'paused') {
    setWriterLockTimings({ heartbeatMs: 200, takeoverGraceMs: 0 });
    const lock = writerLockFor(dir);
    emit({ event: 'acquired', acquired: await lock.ensure() });
    await waitFor('go');
    emit({ event: 'send', owner: await lock.verify() });
    await waitFor('commit');
    emit({ event: 'commit', owner: await lock.verify() });
    return;
  }
  throw new Error(`unknown mode ${mode}`);
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    emit({ event: 'error', message: String(err) });
    process.exit(1);
  }
);
