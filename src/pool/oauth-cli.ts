import { readdir } from 'fs/promises';
import { join } from 'path';
import { parseArgs } from 'util';
import {
  OAuthGrantStore,
  REVISION_DIR,
  oauthStoreDir,
  restoreGrant,
  summarizeGrant,
  type GrantSummary,
} from './oauth-store.js';
import { writerLockFor, writerLockTimings, type OAuthWriterLock } from './oauth-lock.js';

const HELP = `airlock oauth — inspect and restore Airlock-held OAuth grants (never prints secrets)

Usage:
  airlock oauth status [provider] [--json]
  airlock oauth history <provider> [--json]
  airlock oauth restore <provider> <version> [--force] [--json]
  airlock oauth export-legacy [provider] [--json]
  airlock oauth import-legacy [provider] [--json]

Grants are immutable revisions in ~/.airlock/oauth/.grants/<provider>/; <provider>.json is a
mirror. Every replacement keeps the previous grant in ~/.airlock/oauth/.history/<provider>/ (last
10 kept, mode 0600). "restore" puts one of those versions back; the replaced grant is backed up
first, so a restore can be undone.

Writing commands (restore, export-legacy, import-legacy) take the OAuth writer lock, so they run
only while no gateway owns the store: stop it and run them in a one-off container, e.g.
  docker compose stop airlock && docker compose run --rm airlock airlock oauth restore …
restore --force instead takes the lock over from a running gateway (it re-acquires afterwards).

A lock left by a crashed gateway is waited out (up to ~2m45s); a live one is refused at once.
"restore --force" overrides a running gateway; it does not prove the gateway was stopped.

Rollback to an Airlock without grant revisions: stop the gateway, run "export-legacy" (writes the
newest revision of every grant to <provider>.json and verifies it), then start the older build.
Roll-forward only after an older build actually ran: stop it, run "import-legacy" (it PROMOTES
<provider>.json over newer revisions; the replaced one stays in history), then start this one.

Options:
      --dir <path>   OAuth store directory (default: ~/.airlock/oauth)
      --force        restore only: take the writer lock over from its holder
      --json         Machine-readable output
  -h, --help         Show this help
`;

interface CliOutput {
  exitCode: number;
  json: boolean;
  data: unknown;
  text: string;
}

function formatSummary(s: GrantSummary): string {
  const parts = [
    s.unreadable ? 'UNREADABLE' : undefined,
    s.hasRefreshToken ? 'refresh token' : 'no refresh token',
    s.hasAccessToken ? 'access token' : 'no access token',
    s.hasClientInfo ? 'client registration' : 'no client registration',
    s.issuer ? `issuer=${s.issuer}` : undefined,
    s.resource ? `resource=${s.resource}` : undefined,
    s.obtainedAt ? `obtained=${s.obtainedAt}` : undefined,
    s.accessExpiresAt ? `access-expires=${s.accessExpiresAt}` : undefined,
    s.pendingAuthorization ? 'authorization pending' : undefined,
    s.exchange
      ? `REFRESH ${s.exchange.state.toUpperCase()} since ${s.exchange.since} at ${s.exchange.tokenEndpoint} (the issuer may have rotated the refresh token)`
      : undefined,
  ];
  return parts.filter(Boolean).join(', ');
}

export async function oauthCommand(argv: string[]): Promise<CliOutput> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      dir: { type: 'string' },
      force: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });
  const json = values.json ?? false;
  const dir = values.dir ?? oauthStoreDir();
  const [command, provider, version] = positionals;
  if (values.help || !command) {
    return { exitCode: values.help ? 0 : 1, json: false, data: HELP, text: HELP };
  }

  if (command === 'status') {
    // Grants: the `<id>.json` mirrors plus any grant that so far only exists as revisions.
    const files = (await grantIds(dir)).filter((id) => !provider || id === provider);
    const holder = await writerLockFor(dir).holder();
    const grants: Record<string, GrantSummary & { orphanedSuccessors?: number }> = {};
    for (const id of files) {
      const store = new OAuthGrantStore(id, 'readonly', dir);
      try {
        const { data, corrupt } = await store.read();
        grants[id] = corrupt ? { ...summarizeGrant({}), unreadable: true } : summarizeGrant(data);
      } catch {
        grants[id] = { ...summarizeGrant({}), unreadable: true };
      }
      const orphans = (await store.listOrphans()).length;
      if (orphans) grants[id].orphanedSuccessors = orphans;
    }
    const lines = [
      holder
        ? `Writer lock: pid ${holder.pid} on ${holder.hostname} (generation ${holder.gen}, heartbeat ${new Date(holder.heartbeatAt).toISOString()})`
        : 'Writer lock: free',
      ...Object.entries(grants).map(
        ([id, s]) =>
          `  ${id}: ${formatSummary(s)}${s.orphanedSuccessors ? `, ${s.orphanedSuccessors} successor(s) awaiting adoption by the lock holder` : ''}`
      ),
    ];
    if (files.length === 0) lines.push('  (no OAuth grants stored)');
    return {
      exitCode: 0,
      json,
      data: { dir, writer: holder ?? null, grants },
      text: lines.join('\n'),
    };
  }

  if (command === 'history') {
    if (!provider) return usageError('history requires <provider>', json);
    const store = new OAuthGrantStore(provider, 'readonly', dir);
    const entries = await store.history();
    const lines = entries.length
      ? entries.map(
          (e) => `  ${e.version}  (${e.reason}, saved ${e.savedAt})  ${formatSummary(e.summary)}`
        )
      : [`  (no backups for ${provider})`];
    return {
      exitCode: 0,
      json,
      data: { provider, history: entries },
      text: [`Backups for ${provider}, newest first:`, ...lines].join('\n'),
    };
  }

  if (command === 'restore') {
    if (!provider || !version) return usageError('restore requires <provider> <version>', json);
    try {
      await new OAuthGrantStore(provider, 'readonly', dir).readBackup(version);
    } catch (err) {
      return fail(json, describe(err, `No backup ${version} for ${provider}`));
    }
    return withOwnership(dir, json, values.force ?? false, async (warning) => {
      const summary = await restoreGrant(dir, provider, version);
      return {
        exitCode: 0,
        json,
        data: { provider, restored: version, grant: summary, ...(warning ? { warning } : {}) },
        text: `${warning ? `${warning}\n` : ''}Restored ${provider} from ${version}: ${formatSummary(summary)}\nThe replaced grant was backed up first (see "airlock oauth history ${provider}").`,
      };
    });
  }

  if (command === 'export-legacy' || command === 'import-legacy') {
    return withOwnership(dir, json, false, async () => {
      // Enumerated under the lock; a listing error fails the command (never "nothing to do").
      const ids = provider ? [provider] : await grantIds(dir);
      const results: Record<string, unknown> = {};
      const lines: string[] = [];
      let failed = 0;
      for (const id of ids) {
        try {
          const store = new OAuthGrantStore(id, 'writer', dir);
          if (command === 'export-legacy') {
            const r = await store.exportLegacy();
            results[id] = r;
            lines.push(
              r.exported
                ? `  ${id}: wrote revision ${r.rev} to ${id}.json (verified)`
                : `  ${id}: nothing to export (no revisions; ${id}.json is already the grant)`
            );
          } else {
            const r = await store.importLegacy();
            results[id] = { imported: true, rev: r.rev };
            lines.push(
              `  ${id}: imported ${id}.json as revision ${r.rev} (the revision it replaced is in history)`
            );
          }
        } catch (err) {
          failed++;
          results[id] = { error: describe(err, `${id}.json not found`) };
          lines.push(`  ${id}: FAILED: ${describe(err, `${id}.json not found`)}`);
        }
      }
      return {
        exitCode: failed ? 1 : 0,
        json,
        data: { [command]: results, failed },
        text: [
          command === 'export-legacy'
            ? 'Exported the current grants to <provider>.json for an older Airlock:'
            : 'Imported <provider>.json files written by an older Airlock (promoted over newer revisions):',
          ...lines,
          ...(failed
            ? [`${failed} provider(s) failed; nothing is complete until this succeeds.`]
            : []),
        ].join('\n'),
      };
    });
  }

  return usageError(`Unknown oauth command: "${command}"`, json);
}

function fail(json: boolean, message: string): CliOutput {
  return { exitCode: 1, json, data: { error: message }, text: message };
}

function describe(err: unknown, enoent: string): string {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') return enoent;
  return err instanceof Error ? err.message : String(err);
}

/** Only a missing directory is "no entries"; any other listing error propagates. */
async function listDir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function grantIds(dir: string): Promise<string[]> {
  const ids = new Set(
    (await listDir(dir))
      .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
      .map((f) => f.slice(0, -'.json'.length))
  );
  for (const id of await listDir(join(dir, REVISION_DIR))) ids.add(id);
  return Array.from(ids).sort();
}

/**
 * A one-shot CLI (e.g. `docker compose run`) cannot rely on having watched the lock before: give a
 * holder that may have crashed the chance to age out (bounded: staleness + takeover grace +
 * slack). A holder whose heartbeat moves meanwhile is alive: stop waiting at once.
 */
async function waitForAbandonedLock(lock: OAuthWriterLock): Promise<boolean> {
  const { staleMs, takeoverGraceMs, heartbeatMs } = writerLockTimings();
  const deadline = Date.now() + staleMs + takeoverGraceMs + 10_000;
  const first = await lock.holder();
  if (!first) return lock.ensure();
  process.stderr.write(
    `OAuth writer lock is held by pid ${first.pid} on ${first.hostname}; waiting up to ${Math.round((deadline - Date.now()) / 1000)} s to see whether it was abandoned (Ctrl-C to stop)…\n`
  );
  let lastReport = Date.now();
  const poll = Math.min(2_000, Math.max(50, Math.floor(heartbeatMs / 4)));
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, poll));
    const now = await lock.holder();
    if (now && (now.heartbeatAt !== first.heartbeatAt || now.gen !== first.gen)) {
      return false; // heartbeating: a live gateway
    }
    if (await lock.ensure()) return true;
    if (Date.now() - lastReport >= 15_000) {
      lastReport = Date.now();
      process.stderr.write(
        `  still waiting (${Math.round((deadline - Date.now()) / 1000)} s left)…\n`
      );
    }
  }
  return false;
}

/**
 * Run an operator write while holding the OAuth writer lock. Refuses while another live process
 * (the gateway) holds it: stop it first, or for `restore` use --force to take the lock over.
 */
async function withOwnership(
  dir: string,
  json: boolean,
  force: boolean,
  fn: (warning?: string) => Promise<CliOutput>
): Promise<CliOutput> {
  const lock = writerLockFor(dir);
  // Same process already owns the store (embedded use): run under that ownership, keep it.
  const alreadyHeld = lock.held;
  let warning: string | undefined;
  let acquired = await lock.ensure();
  if (!acquired && !force) acquired = await waitForAbandonedLock(lock);
  if (!acquired && !force) {
    const holder = await lock.holder();
    return fail(
      json,
      `The OAuth writer lock is held by ${holder ? `pid ${holder.pid} on ${holder.hostname}` : 'another process'} (${lock.lastProblem ?? 'held'}). ` +
        'Stop the gateway first (e.g. "docker compose stop airlock" and run this with "docker compose run --rm"), or for restore use --force to take the lock over.'
    );
  }
  if (!acquired) {
    warning =
      'WARNING: --force takes the OAuth writer lock over from its holder. That process becomes read-only for OAuth until it re-acquires the lock; a refresh it has in flight is parked for adoption, not lost.';
    acquired = await lock.forceAcquire();
    if (!acquired)
      return fail(json, `Could not take the OAuth writer lock over (${lock.lastProblem})`);
  }
  try {
    return await fn(warning);
  } catch (err) {
    return fail(json, describe(err, 'not found'));
  } finally {
    if (!alreadyHeld) await lock.release();
  }
}

function usageError(message: string, json: boolean): CliOutput {
  return { exitCode: 1, json, data: { error: message }, text: `${message}\n\n${HELP}` };
}

export async function runOAuthCli(argv: string[]): Promise<void> {
  const result = await oauthCommand(argv);
  if (result.json) {
    process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`);
  } else {
    process.stdout.write(`${result.text}\n`);
  }
  process.exitCode = result.exitCode;
}
