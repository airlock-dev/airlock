import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { CliCommandConfig, CliParamConfig } from '../../config/schema.js';
import { inferType } from './help-parser.js';

interface DiscoveredCommands {
  [name: string]: CliCommandConfig;
}

interface CompletionCandidate {
  name: string;
  description?: string;
  type?: string;
}

export interface CompletionProvider {
  list(path: string[], incomplete: string): CompletionCandidate[] | null;
  describe?(path: string[]): string | undefined;
}

interface CompletionAdapter {
  id: string;
  detect(tool: string): boolean;
  createProvider(tool: string): CompletionProvider | null;
}

interface CompletionDiscoveryResult {
  adapterId: string;
  commands: DiscoveredCommands;
}

export interface CompletionSession {
  adapterId: string;
  listTopLevelSubcommands(): string[];
  loadPath(path: string[], options?: { maxDepth?: number }): DiscoveredCommands;
  loadCommand(path: string[], name?: string): CliCommandConfig | null;
}

function execLines(bin: string, args: string[], env?: Record<string, string>): string[] | null {
  try {
    const out = execFileSync(bin, args, {
      timeout: 5000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env ? { ...process.env, ...env } : process.env,
    });
    return out
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'stdout' in err) {
      const stdout = (err as { stdout?: string }).stdout ?? '';
      if (stdout.trim()) {
        return stdout
          .split('\n')
          .map((line) => line.trimEnd())
          .filter((line) => line.length > 0);
      }
    }
    return null;
  }
}

function getDescription(bin: string, subcommandPath: string[]): string | undefined {
  const out = execLines(bin, [...subcommandPath, '--help']);
  return out?.[0]?.trim() || undefined;
}

function normalizeFlag(flag: string): string {
  return flag.replace(/[=,:]+$/, '');
}

function normalizeParamName(flag: string): string {
  return normalizeFlag(flag).replace(/^--?/, '').replace(/-/g, '_');
}

function mergeCandidates(...groups: CompletionCandidate[][]): CompletionCandidate[] {
  const merged = new Map<string, CompletionCandidate>();
  for (const group of groups) {
    for (const candidate of group) {
      if (!candidate.name) continue;
      const existing = merged.get(candidate.name);
      if (!existing) {
        merged.set(candidate.name, candidate);
        continue;
      }
      if (!existing.description && candidate.description) {
        existing.description = candidate.description;
      }
      if (!existing.type && candidate.type) {
        existing.type = candidate.type;
      }
    }
  }
  return [...merged.values()];
}

function classifyCandidates(candidates: CompletionCandidate[]): {
  subcommands: CompletionCandidate[];
  flags: CompletionCandidate[];
} {
  const subcommands: CompletionCandidate[] = [];
  const flags: CompletionCandidate[] = [];

  for (const candidate of candidates) {
    if (!candidate.name) continue;
    if (candidate.name.startsWith('-')) {
      flags.push(candidate);
      continue;
    }
    if (candidate.type === 'file' || candidate.type === 'dir') continue;
    subcommands.push(candidate);
  }

  return { subcommands, flags };
}

function paramsFromFlags(flags: CompletionCandidate[]): Record<string, CliParamConfig> {
  const params: Record<string, CliParamConfig> = {};

  for (const flag of flags) {
    const longFlag = normalizeFlag(flag.name);
    if (/^-[A-Za-z0-9]$/.test(longFlag)) continue;

    const paramName = normalizeParamName(longFlag);
    const desc = flag.description ?? '';
    const hasValueHint =
      /[=<[]/.test(flag.name) ||
      /\b(value|path|file|dir|name|id|url|port|timeout|count)\b/i.test(desc);
    const isBoolean =
      !hasValueHint &&
      (longFlag.startsWith('--no-') || desc ? inferType(longFlag, desc) === 'boolean' : true);

    params[paramName] = {
      type: isBoolean ? 'boolean' : inferType(longFlag, desc),
      flag: longFlag,
      positional: false,
      required: false,
      description: flag.description,
    };
  }

  return params;
}

function discoverFromProvider(
  tool: string,
  provider: CompletionProvider,
  options?: { maxDepth?: number; include?: string[]; exclude?: string[]; startPath?: string[] }
): DiscoveredCommands {
  const maxDepth = options?.maxDepth ?? 2;
  const include = options?.include ? new Set(options.include) : undefined;
  const exclude = options?.exclude ? new Set(options.exclude) : undefined;
  const startPath = options?.startPath ?? [];

  const commands: DiscoveredCommands = {};
  const seenPaths = new Set<string>();

  function discover(path: string[], prefix: string, depth: number): void {
    const neutral = provider.list(path, '') ?? [];
    const dashed = provider.list(path, '-') ?? [];
    const candidates = mergeCandidates(neutral, dashed);
    if (candidates.length === 0) return;

    const { subcommands, flags } = classifyCandidates(candidates);

    if (flags.length > 0 || subcommands.length === 0) {
      const cmdName = prefix || tool;
      if (!exclude?.has(cmdName) && (!include || include.has(cmdName))) {
        commands[cmdName] = {
          exec: [tool, ...path].join(' '),
          description: provider.describe?.(path),
          params: paramsFromFlags(flags),
          timeout: 30,
        };
      }
    }

    if (depth >= maxDepth) return;

    for (const sub of subcommands) {
      if (exclude?.has(sub.name)) continue;

      const newPath = [...path, sub.name];
      const key = newPath.join(' ');
      if (seenPaths.has(key)) continue;
      seenPaths.add(key);

      const newPrefix = prefix ? `${prefix}_${sub.name}` : sub.name;
      discover(newPath, newPrefix, depth + 1);
    }
  }

  discover(startPath, startPath.join('_'), 0);
  return commands;
}

function loadCommandFromProvider(
  tool: string,
  provider: CompletionProvider,
  path: string[]
): CliCommandConfig | null {
  const neutral = provider.list(path, '') ?? [];
  const dashed = provider.list(path, '-') ?? [];
  const candidates = mergeCandidates(neutral, dashed);
  if (candidates.length === 0) return null;

  const { subcommands, flags } = classifyCandidates(candidates);
  if (flags.length === 0 && subcommands.length > 0) {
    return null;
  }

  return {
    exec: [tool, ...path].join(' '),
    description: provider.describe?.(path),
    params: paramsFromFlags(flags),
    timeout: 30,
  };
}

function parseCobraLine(line: string): CompletionCandidate | null {
  if (!line || line.startsWith(':')) return null;
  const tabIdx = line.indexOf('\t');
  if (tabIdx >= 0) {
    return {
      name: line.slice(0, tabIdx).trim(),
      description: line.slice(tabIdx + 1).trim() || undefined,
    };
  }
  return { name: line.trim() };
}

function parseClickLine(line: string): CompletionCandidate | null {
  const tabIdx = line.indexOf('\t');
  const raw = tabIdx >= 0 ? line.slice(0, tabIdx) : line;
  const help = tabIdx >= 0 ? line.slice(tabIdx + 1).trim() || undefined : undefined;
  const commaIdx = raw.indexOf(',');
  if (commaIdx < 0) return null;

  const type = raw.slice(0, commaIdx).trim();
  const name = raw.slice(commaIdx + 1).trim();
  if (!name) return null;
  return { name, description: help, type };
}

function parsePlainLine(line: string): CompletionCandidate | null {
  if (!line) return null;
  const tabIdx = line.indexOf('\t');
  if (tabIdx >= 0) {
    return {
      name: line.slice(0, tabIdx).trim(),
      description: line.slice(tabIdx + 1).trim() || undefined,
    };
  }
  return { name: line.trim() };
}

function toolEnvName(tool: string): string {
  const base = tool.split(/[\\/]/).pop() ?? tool;
  return `_${base.replace(/-/g, '_').toUpperCase()}_COMPLETE`;
}

function runCobraComplete(
  tool: string,
  path: string[],
  incomplete: string
): CompletionCandidate[] | null {
  const out = execLines(tool, ['__complete', ...path, incomplete]);
  if (!out) return null;
  return out.map(parseCobraLine).filter((item): item is CompletionCandidate => item !== null);
}

function runClickComplete(
  tool: string,
  path: string[],
  incomplete: string
): CompletionCandidate[] | null {
  const words = [tool, ...path];
  let cword = words.length;
  if (incomplete) {
    words.push(incomplete);
    cword = words.length - 1;
  }

  const out = execLines(tool, [], {
    [toolEnvName(tool)]: 'bash_complete',
    COMP_WORDS: words.join(' '),
    COMP_CWORD: String(cword),
  });
  if (!out) return null;
  return out.map(parseClickLine).filter((item): item is CompletionCandidate => item !== null);
}

function runClapComplete(
  tool: string,
  path: string[],
  incomplete: string
): CompletionCandidate[] | null {
  const words = [tool, ...path, incomplete];
  const out = execLines(tool, ['--', ...words], {
    COMPLETE: 'bash',
    _CLAP_COMPLETE_INDEX: String(words.length - 1),
    _CLAP_COMPLETE_COMP_TYPE: '9',
    _CLAP_COMPLETE_SPACE: 'true',
    _CLAP_IFS: '\n',
  });
  if (!out) return null;
  return out.map(parsePlainLine).filter((item): item is CompletionCandidate => item !== null);
}

function looksLikeScript(lines: string[] | null): boolean {
  if (!lines || lines.length === 0) return false;
  const text = lines.join('\n');
  return (
    text.includes('complete -F') ||
    text.includes('compdef ') ||
    text.includes('COMPREPLY') ||
    text.includes('compgen ') ||
    text.includes('complete -c ')
  );
}

const GENERATOR_ARG_CANDIDATES = [
  ['completion', 'bash'],
  ['completions', 'bash'],
  ['completion', '--shell', 'bash'],
  ['completions', '--shell', 'bash'],
  ['generate-completion', 'bash'],
  ['gen-completion', 'bash'],
  ['shell-completion', 'bash'],
  ['completion', 'script', 'bash'],
];

interface ScriptAdapterSession {
  cleanup(): void;
  list(path: string[], incomplete: string): CompletionCandidate[] | null;
}

function setupScriptAdapter(tool: string): ScriptAdapterSession | null {
  for (const args of GENERATOR_ARG_CANDIDATES) {
    const script = execLines(tool, args);
    if (!script || !looksLikeScript(script)) continue;
    const scriptText = script.join('\n');

    const dir = mkdtempSync(join(tmpdir(), 'airlock-completion-'));
    const scriptPath = join(dir, `${tool.replace(/[^A-Za-z0-9_-]/g, '_')}.bash`);
    writeFileSync(scriptPath, scriptText);

    const completeSpec = execLines(
      'bash',
      [
        '-lc',
        'source "$AIRLOCK_SCRIPT" >/dev/null 2>&1 && complete -p "$AIRLOCK_TOOL" 2>/dev/null',
      ],
      {
        AIRLOCK_SCRIPT: scriptPath,
        AIRLOCK_TOOL: tool,
      }
    );
    const spec = completeSpec?.join('\n') ?? '';
    const fnMatch = spec.match(/-F\s+(\S+)/);
    if (!fnMatch) {
      rmSync(dir, { recursive: true, force: true });
      continue;
    }

    const fnName = fnMatch[1];
    return {
      cleanup() {
        rmSync(dir, { recursive: true, force: true });
      },
      list(path: string[], incomplete: string): CompletionCandidate[] | null {
        const words = [tool, ...path, incomplete];
        const line = words.filter((word) => word.length > 0).join(' ');
        const prev = path[path.length - 1] ?? tool;
        const out = execLines(
          'bash',
          [
            '-lc',
            'source "$AIRLOCK_SCRIPT" >/dev/null 2>&1 && AIRLOCK_WORDS_ARR=() && while IFS= read -r line; do AIRLOCK_WORDS_ARR+=("$line"); done <<< "$AIRLOCK_WORDS" && COMP_WORDS=("${AIRLOCK_WORDS_ARR[@]}") && COMP_CWORD="$AIRLOCK_CWORD" && COMP_LINE="$AIRLOCK_LINE" && COMP_POINT=${#COMP_LINE} && COMP_TYPE=9 && COMPREPLY=() && "$AIRLOCK_FUNC" "$AIRLOCK_TOOL" "$AIRLOCK_CUR" "$AIRLOCK_PREV" && printf "%s\n" "${COMPREPLY[@]}"',
          ],
          {
            AIRLOCK_SCRIPT: scriptPath,
            AIRLOCK_TOOL: tool,
            AIRLOCK_FUNC: fnName,
            AIRLOCK_CWORD: String(words.length - 1),
            AIRLOCK_LINE: line,
            AIRLOCK_CUR: incomplete,
            AIRLOCK_PREV: incomplete ? prev : (path[path.length - 1] ?? tool),
            AIRLOCK_WORDS: words.join('\n'),
          }
        );

        return (
          out?.map(parsePlainLine).filter((item): item is CompletionCandidate => item !== null) ??
          null
        );
      },
    };
  }

  return null;
}

const cobraAdapter: CompletionAdapter = {
  id: 'cobra',
  detect(tool) {
    const result = runCobraComplete(tool, [], '');
    return result !== null && result.length > 0;
  },
  createProvider(tool) {
    if (!this.detect(tool)) return null;
    return {
      list(path, incomplete) {
        return runCobraComplete(tool, path, incomplete);
      },
      describe(path) {
        return getDescription(tool, path);
      },
    };
  },
};

const clickAdapter: CompletionAdapter = {
  id: 'click',
  detect(tool) {
    const result = runClickComplete(tool, [], '');
    return result !== null && result.length > 0;
  },
  createProvider(tool) {
    if (!this.detect(tool)) return null;
    return {
      list(path, incomplete) {
        return runClickComplete(tool, path, incomplete);
      },
      describe(path) {
        return getDescription(tool, path);
      },
    };
  },
};

const clapAdapter: CompletionAdapter = {
  id: 'clap',
  detect(tool) {
    const result = runClapComplete(tool, [], '');
    return result !== null && result.length > 0;
  },
  createProvider(tool) {
    if (!this.detect(tool)) return null;
    return {
      list(path, incomplete) {
        return runClapComplete(tool, path, incomplete);
      },
      describe(path) {
        return getDescription(tool, path);
      },
    };
  },
};

const scriptAdapter: CompletionAdapter = {
  id: 'shell-script',
  detect(tool) {
    const session = setupScriptAdapter(tool);
    if (!session) return false;
    session.cleanup();
    return true;
  },
  createProvider(tool) {
    const session = setupScriptAdapter(tool);
    if (!session) return null;
    process.once('exit', () => session.cleanup());

    return {
      list(path, incomplete) {
        return session.list(path, incomplete);
      },
      describe(path) {
        return getDescription(tool, path);
      },
    };
  },
};

const COMPLETION_ADAPTERS: CompletionAdapter[] = [
  cobraAdapter,
  clickAdapter,
  clapAdapter,
  scriptAdapter,
];

function createSessionWithAdapter(
  tool: string,
  adapter: CompletionAdapter
): CompletionSession | null {
  const provider = adapter.createProvider(tool);
  if (!provider) return null;

  let topLevelCache: string[] | null = null;
  const pathCache = new Map<string, DiscoveredCommands>();
  const commandCache = new Map<string, CliCommandConfig | null>();

  return {
    adapterId: adapter.id,
    listTopLevelSubcommands() {
      if (topLevelCache) return topLevelCache;
      const neutral = provider.list([], '') ?? [];
      const dashed = provider.list([], '-') ?? [];
      const candidates = mergeCandidates(neutral, dashed);
      const { subcommands } = classifyCandidates(candidates);
      topLevelCache = subcommands.map((candidate) => candidate.name);
      return topLevelCache;
    },
    loadPath(path, options) {
      const key = `${path.join(' ')}|${options?.maxDepth ?? 2}`;
      const cached = pathCache.get(key);
      if (cached) return cached;

      const commands = discoverFromProvider(tool, provider, {
        maxDepth: options?.maxDepth,
        startPath: path,
      });
      pathCache.set(key, commands);
      return commands;
    },
    loadCommand(path, name) {
      const key = `${path.join(' ')}|${name ?? ''}`;
      if (commandCache.has(key)) return commandCache.get(key) ?? null;
      const command = loadCommandFromProvider(tool, provider, path);
      commandCache.set(key, command);
      return command;
    },
  };
}

export function createCompletionSession(tool: string): CompletionSession | null {
  for (const adapter of COMPLETION_ADAPTERS) {
    const session = createSessionWithAdapter(tool, adapter);
    if (session) return session;
  }
  return null;
}

export function detectCompletionSupport(tool: string): string | null {
  for (const adapter of COMPLETION_ADAPTERS) {
    if (adapter.detect(tool)) return adapter.id;
  }
  return null;
}

export function discoverViaCompletion(
  tool: string,
  options?: { maxDepth?: number; include?: string[]; exclude?: string[] }
): CompletionDiscoveryResult | null {
  for (const adapter of COMPLETION_ADAPTERS) {
    const provider = adapter.createProvider(tool);
    if (!provider) continue;

    return {
      adapterId: adapter.id,
      commands: discoverFromProvider(tool, provider, options),
    };
  }

  return null;
}

/**
 * Dedup aliases: when multiple command names have the same exec, keep only the longest name.
 * e.g. "calendar" and "cal" both exec "gog calendar" — keep "calendar".
 */
export function deduplicateAliases(commands: DiscoveredCommands): DiscoveredCommands {
  const byExec = new Map<string, string[]>();
  for (const [name, cmd] of Object.entries(commands)) {
    const exec = cmd.exec;
    if (!byExec.has(exec)) byExec.set(exec, []);
    byExec.get(exec)!.push(name);
  }

  const result: DiscoveredCommands = {};
  for (const names of byExec.values()) {
    const canonical = names.sort((a, b) => b.length - a.length)[0];
    result[canonical] = commands[canonical];
  }

  return result;
}
