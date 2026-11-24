import { readdir } from 'fs/promises';
import { parseArgs } from 'util';
import {
  OAuthGrantStore,
  oauthStoreDir,
  summarizeGrant,
  type GrantSummary,
} from './oauth-store.js';
import { writerLockFor } from './oauth-lock.js';

const HELP = `airlock oauth — inspect and restore Airlock-held OAuth grants (never prints secrets)

Usage:
  airlock oauth status [provider] [--json]
  airlock oauth history <provider> [--json]
  airlock oauth restore <provider> <version> [--json]

Every replacement of a grant file (refresh rotation, new authorization, restore) first copies the
previous grant to ~/.airlock/oauth/.history/<provider>/ (last 10 kept, mode 0600). "restore" puts
one of those versions back; the grant it replaces is backed up too, so a restore can be undone.
A running gateway picks a restored grant up on its next token read or refresh retry.

Options:
      --dir <path>   OAuth store directory (default: ~/.airlock/oauth)
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
  ];
  return parts.filter(Boolean).join(', ');
}

export async function oauthCommand(argv: string[]): Promise<CliOutput> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      dir: { type: 'string' },
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
    const grants: Record<string, GrantSummary> = {};
    for (const id of files) {
      const store = new OAuthGrantStore(id, 'readonly', dir);
      try {
        const { data, corrupt } = await store.read();
        grants[id] = corrupt ? { ...summarizeGrant({}), unreadable: true } : summarizeGrant(data);
      } catch {
        grants[id] = { ...summarizeGrant({}), unreadable: true };
      }
    }
    const lines = [
      holder
        ? `Writer lock: pid ${holder.pid} on ${holder.hostname} (heartbeat ${new Date(holder.heartbeatAt).toISOString()})`
        : 'Writer lock: free',
      ...Object.entries(grants).map(([id, s]) => `  ${id}: ${formatSummary(s)}`),
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
    const store = new OAuthGrantStore(provider, 'readonly', dir);
    try {
      const summary = await store.restore(version);
      return {
        exitCode: 0,
        json,
        data: { provider, restored: version, grant: summary },
        text: `Restored ${provider} from ${version}: ${formatSummary(summary)}\nThe replaced grant was backed up first (see "airlock oauth history ${provider}").`,
      };
    } catch (err) {
      const message =
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? `No backup ${version} for ${provider}`
          : err instanceof Error
            ? err.message
            : String(err);
      return { exitCode: 1, json, data: { error: message }, text: message };
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
