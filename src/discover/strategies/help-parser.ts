import { execFileSync } from 'child_process';
import type { CliCommandConfig, CliParamConfig } from '../../config/schema.js';

interface DiscoveredCommands {
  [name: string]: CliCommandConfig;
}

export interface ParsedFlag {
  name: string;
  flag: string;
  type: 'string' | 'number' | 'boolean';
  description?: string;
  required: boolean;
}

function runHelp(command: string): string {
  // Split "docker container ls" into ["docker", "container", "ls", "--help"]
  // Using execFileSync avoids shell injection — the first element is the binary,
  // the rest are passed as arguments directly (no shell interpretation).
  const parts = command.split(/\s+/);
  const bin = parts[0];
  const args = [...parts.slice(1), '--help'];
  try {
    return execFileSync(bin, args, {
      timeout: 10000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err: unknown) {
    // Many CLIs exit non-zero for --help
    if (err && typeof err === 'object' && 'stdout' in err) {
      return (err as { stdout: string }).stdout ?? '';
    }
    return '';
  }
}

export function inferType(flag: string, description: string): 'string' | 'number' | 'boolean' {
  const lower = description.toLowerCase();
  // Boolean indicators: no argument expected
  if (/\b(enable|disable|verbose|quiet|force|dry-run|no-)\b/.test(lower)) return 'boolean';
  if (!description.includes(' ') && /^-\w$/.test(flag)) return 'boolean';
  // Number indicators
  if (/\b(count|number|num|max|min|limit|timeout|port|size|depth)\b/.test(lower)) return 'number';
  if (/\bN\b/.test(description) && description.length < 50) return 'number';
  return 'string';
}

export function parseFlags(helpText: string): ParsedFlag[] {
  const flags: ParsedFlag[] = [];

  const longFlagRegex =
    /^\s{2,}(?:(-\w),\s*)?(--[\w-]+)(?:[= ]\s*(?:<(\w+)>|\[(\w+)\]|(\w+)))?\s{2,}(.+)/gm;

  let match;
  while ((match = longFlagRegex.exec(helpText)) !== null) {
    const longFlag = match[2];
    const argName = match[3] ?? match[4] ?? match[5];
    const description = match[6]?.trim() ?? '';

    const name = longFlag.replace(/^--/, '').replace(/-/g, '_');
    const hasArg = !!argName;
    const type = hasArg ? inferType(longFlag, description) : 'boolean';

    flags.push({
      name,
      flag: longFlag,
      type,
      description: description || undefined,
      required: false,
    });
  }

  return flags;
}

export function parseSubcommands(helpText: string): string[] {
  const subcommands: string[] = [];
  // Look for lines under "Commands:", "Available Commands:", "COMMANDS:", etc.
  const sectionRegex = /(?:commands|subcommands|available commands):\s*\n((?:\s{2,}\S.*\n?)*)/gi;
  let match;

  while ((match = sectionRegex.exec(helpText)) !== null) {
    const block = match[1];
    const cmdRegex = /^\s{2,}(\w[\w-]*)/gm;
    let cmdMatch;
    while ((cmdMatch = cmdRegex.exec(block)) !== null) {
      subcommands.push(cmdMatch[1]);
    }
  }

  return subcommands;
}

export function discoverCli(
  command: string,
  options?: { maxDepth?: number; include?: string[]; exclude?: string[] }
): DiscoveredCommands {
  const maxDepth = options?.maxDepth ?? 2;
  const include = options?.include ? new Set(options.include) : undefined;
  const exclude = options?.exclude ? new Set(options.exclude) : undefined;

  const commands: DiscoveredCommands = {};

  function discover(cmd: string, prefix: string, depth: number): void {
    const helpText = runHelp(cmd);
    if (!helpText) return;

    const flags = parseFlags(helpText);
    const subcommands = parseSubcommands(helpText);

    // If this has flags, register as a command
    if (flags.length > 0 || subcommands.length === 0) {
      const name = prefix || command;

      if (exclude?.has(name)) return;
      if (include && !include.has(name)) return;

      const params: Record<string, CliParamConfig> = {};
      for (const flag of flags) {
        params[flag.name] = {
          type: flag.type,
          flag: flag.flag,
          positional: false,
          required: flag.required,
          description: flag.description,
        };
      }

      commands[name] = {
        exec: cmd,
        description: helpText.split('\n')[0]?.trim() || undefined,
        params,
        timeout: 30,
      };
    }

    // Recurse into subcommands
    if (depth < maxDepth) {
      for (const sub of subcommands) {
        if (exclude?.has(sub)) continue;
        discover(`${cmd} ${sub}`, prefix ? `${prefix}_${sub}` : sub, depth + 1);
      }
    }
  }

  discover(command, '', 0);
  return commands;
}
