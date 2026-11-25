import { readdir } from 'fs/promises';
import { parseArgs } from 'util';
import {
  OAuthGrantStore,
  oauthStoreDir,
  restoreGrant,
  submitRestoreRequest,
  summarizeGrant,
  type GrantSummary,
} from './oauth-store.js';
import { writerLockFor } from './oauth-lock.js';

const HELP = `airlock oauth — inspect and restore Airlock-held OAuth grants (never prints secrets)

Usage:
  airlock oauth status [provider] [--json]
  airlock oauth history <provider> [--json]
  airlock oauth restore <provider> <version> [--wait <seconds>] [--force] [--json]

Every replacement of a grant file (refresh rotation, new authorization, restore) keeps the
previous grant in ~/.airlock/oauth/.history/<provider>/ (last 10 kept, mode 0600). "restore" puts
one of those versions back; the grant it replaces is backed up too, so a restore can be undone.

A restore never races a refresh. When another Airlock process (the gateway) holds the OAuth writer
lock, the restore is handed to that process, which applies it between refreshes; this command
waits for its answer (--wait, default 30 s). Without a running holder, this command takes the lock
itself for the duration of the restore.

Options:
      --dir <path>      OAuth store directory (default: ~/.airlock/oauth)
      --wait <seconds>  How long to wait for the lock holder to apply a restore (default 30)
      --force           Take the writer lock over from its holder (even a live one) and restore.
                        The holder becomes read-only until it re-acquires the lock. Only for a
                        holder that is wedged; prefer stopping it.
      --json            Machine-readable output
  -h, --help            Show this help
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
      wait: { type: 'string' },
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
    const files = (await readdir(dir).catch(() => [] as string[]))
      .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
      .map((f) => f.slice(0, -'.json'.length))
      .filter((id) => !provider || id === provider)
      .sort();
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
    const waitSec = values.wait === undefined ? 30 : Number(values.wait);
    if (!Number.isFinite(waitSec) || waitSec < 0) return usageError('--wait expects seconds', json);
    const fail = (message: string): CliOutput => ({
      exitCode: 1,
      json,
      data: { error: message },
      text: message,
    });
    const errorMessage = (err: unknown) =>
      (err as NodeJS.ErrnoException).code === 'ENOENT'
        ? `No backup ${version} for ${provider}`
        : err instanceof Error
          ? err.message
          : String(err);
    try {
      await new OAuthGrantStore(provider, 'readonly', dir).readBackup(version);
    } catch (err) {
      return fail(errorMessage(err));
    }
    const done = (summary: GrantSummary, via: string, warning?: string): CliOutput => ({
      exitCode: 0,
      json,
      data: { provider, restored: version, via, grant: summary, ...(warning ? { warning } : {}) },
      text: `${warning ? `${warning}\n` : ''}Restored ${provider} from ${version} (${via}): ${formatSummary(summary)}\nThe replaced grant was backed up first (see "airlock oauth history ${provider}").`,
    });

    const lock = writerLockFor(dir);
    // Same process already owns the store (embedded use): restore under that ownership, keep it.
    const alreadyHeld = lock.held;
    let warning: string | undefined;
    let acquired = await lock.ensure();
    if (!acquired && !values.force) {
      const holder = await lock.holder();
      const result = await submitRestoreRequest(dir, provider, version, waitSec * 1000);
      if (result?.ok && result.summary) return done(result.summary, 'applied by the lock holder');
      if (result) return fail(`The OAuth writer lock holder refused the restore: ${result.error}`);
      return fail(
        `The OAuth writer lock is held by ${holder ? `pid ${holder.pid} on ${holder.hostname}` : 'another process'}, which did not apply the restore within ${waitSec}s. ` +
          'Retry with a longer --wait, stop that process and retry, or use --force to take the lock over.'
      );
    }
    if (!acquired && values.force) {
      warning =
        'WARNING: --force takes the OAuth writer lock over from its holder. That process becomes read-only for OAuth until it re-acquires the lock; a refresh it has in flight is parked for adoption, not lost.';
      acquired = await lock.forceAcquire();
      if (!acquired) return fail(`Could not take the OAuth writer lock over (${lock.lastProblem})`);
    }
    try {
      const summary = await restoreGrant(dir, provider, version);
      return done(summary, 'applied directly while holding the writer lock', warning);
    } catch (err) {
      return fail(errorMessage(err));
    } finally {
      if (!alreadyHeld) await lock.release();
    }
  }

  return usageError(`Unknown oauth command: "${command}"`, json);
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
