/**
 * A separate OS process contending for the OAuth writer lock (run with `node --import tsx`).
 * Used by oauth-lifecycle.test.ts; prints one JSON line per event on stdout.
 *
 *   race <dir> <staleMs>   observe the current lock, wait until it is stale, wait for <dir>/go,
 *                          then try to take it over and report; re-verify after a second.
 *   paused <dir>           acquire, wait for <dir>/go, fencing check ("send"), wait for
 *                          <dir>/commit, fencing check again ("commit").
 *   cli <graceMs> <args…>  run `airlock oauth <args…>` exactly as src/index.ts does (no explicit
 *                          exit), with the given takeover grace.
 *   gateway <mcpUrl> <callbackPort>
 *                          a writer ClientPool for provider "fake" (store under $HOME), with the
 *                          gateway's SIGTERM handling; prints "refreshing" when it starts a refresh.
 */
import { existsSync } from 'fs';
import { join } from 'path';
import { setWriterLockTimings, writerLockFor } from '../../src/pool/oauth-lock.js';
import { runOAuthCli } from '../../src/pool/oauth-cli.js';
import { ClientPool } from '../../src/pool/pool.js';
import { McpServerConfig } from '../../src/config/schema.js';
import { SHUTDOWN_FORCE_EXIT_MS } from '../../src/pool/oauth-refresh.js';

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

const argv = process.argv.slice(2);
if (argv[0] === 'cli') {
  // Like src/index.ts: no explicit exit; the process ends when nothing keeps it alive.
  setWriterLockTimings({ takeoverGraceMs: Number(argv[1]) });
  void runOAuthCli(argv.slice(2));
} else if (argv[0] === 'gateway') {
  void (async () => {
    const [, mcpUrl, callbackPort] = argv;
    const pool = new ClientPool(
      {
        fake: McpServerConfig.parse({
          type: 'http',
          url: mcpUrl,
          oauth: true,
          oauth_callback_port: Number(callbackPort),
        }),
      },
      { oauthStorage: 'writer' }
    );
    // Same shutdown sequence as src/index.ts (gateway.stop() → pool.stop()).
    let shuttingDown = false;
    process.on('SIGTERM', () => {
      if (shuttingDown) return;
      shuttingDown = true;
      emit({ event: 'sigterm' });
      const forceExit = setTimeout(() => process.exit(1), SHUTDOWN_FORCE_EXIT_MS);
      forceExit.unref();
      void pool.stop().finally(() => {
        emit({ event: 'stopped' });
        process.exit(0);
      });
    });
    await pool.initialize();
    const client = (
      pool as unknown as { clients: Map<string, { proactiveRefresh(): Promise<void> }> }
    ).clients.get('fake')!;
    emit({ event: 'refreshing' });
    await client.proactiveRefresh();
    emit({ event: 'refreshed' });
    setInterval(() => {}, 1000);
  })().catch((err: unknown) => emit({ event: 'error', message: String(err) }));
} else {
  main().then(
    () => process.exit(0),
    (err: unknown) => {
      emit({ event: 'error', message: String(err) });
      process.exit(1);
    }
  );
}
