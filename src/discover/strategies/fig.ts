import type { CliCommandConfig, CliParamConfig } from '../../config/schema.js';

interface FigOption {
  name: string | string[];
  description?: string;
  args?: { name?: string; isOptional?: boolean } | { name?: string; isOptional?: boolean }[];
}

interface FigSubcommand {
  name: string | string[];
  description?: string;
  options?: FigOption[];
  subcommands?: FigSubcommand[];
  args?: unknown;
}

interface FigSpec {
  name: string;
  description?: string;
  options?: FigOption[];
  subcommands?: FigSubcommand[];
}

export async function fetchFigSpec(tool: string): Promise<FigSpec | null> {
  // Validate tool name to prevent path traversal in URL
  if (!/^[a-zA-Z0-9_-]+$/.test(tool)) return null;

  const url = `https://raw.githubusercontent.com/withfig/autocomplete/master/src/${tool}.ts`;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;

    const text = await response.text();
    return parseFigTypeScript(text, tool);
  } catch {
    return null;
  }
}

function parseFigTypeScript(source: string, toolName: string): FigSpec | null {
  // Best-effort extraction: strip TS syntax and parse the object literal as JSON.
  // This works for simple specs but will silently return null for specs that use
  // template literals, function calls, spread operators, or complex TS features.
  try {
    // Find the main object after "const completionSpec"
    const match = source.match(
      /const\s+completionSpec\s*(?::\s*\w+(?:\.\w+)*)?\s*=\s*(\{[\s\S]*\})\s*;?\s*$/m
    );
    if (!match) return null;

    let objStr = match[1];

    // Strip TypeScript-specific syntax for eval-safe JSON
    // Remove trailing commas before } or ]
    objStr = objStr.replace(/,\s*([}\]])/g, '$1');
    // Quote unquoted keys
    objStr = objStr.replace(/(\s)(\w+)\s*:/g, '$1"$2":');
    // Remove single-line comments
    objStr = objStr.replace(/\/\/.*$/gm, '');

    // This is best-effort — many Fig specs won't parse cleanly
    const parsed = JSON.parse(objStr) as Record<string, unknown>;
    return {
      name: toolName,
      description: parsed.description as string | undefined,
      options: parsed.options as FigOption[] | undefined,
      subcommands: parsed.subcommands as FigSubcommand[] | undefined,
    };
  } catch {
    return null;
  }
}

export function figSpecToCommands(spec: FigSpec): Record<string, CliCommandConfig> {
  const commands: Record<string, CliCommandConfig> = {};

  function processSubcommand(sub: FigSubcommand, prefix: string): void {
    const names = Array.isArray(sub.name) ? sub.name : [sub.name];
    const name = names[0];
    const fullName = prefix ? `${prefix}_${name}` : name;

    const params: Record<string, CliParamConfig> = {};

    for (const opt of sub.options ?? []) {
      const optNames = Array.isArray(opt.name) ? opt.name : [opt.name];
      const longName = optNames.find((n) => n.startsWith('--')) ?? optNames[0];
      const paramName = longName.replace(/^-+/, '').replace(/-/g, '_');

      const hasArgs = opt.args && (!Array.isArray(opt.args) || opt.args.length > 0);
      params[paramName] = {
        type: hasArgs ? 'string' : 'boolean',
        flag: longName,
        positional: false,
        required: false,
        description: opt.description,
      };
    }

    commands[fullName] = {
      exec: `${spec.name} ${prefix ? prefix.replace(/_/g, ' ') + ' ' : ''}${name}`,
      description: sub.description,
      params,
      timeout: 30,
    };

    for (const child of sub.subcommands ?? []) {
      processSubcommand(child, fullName);
    }
  }

  for (const sub of spec.subcommands ?? []) {
    processSubcommand(sub, '');
  }

  return commands;
}
