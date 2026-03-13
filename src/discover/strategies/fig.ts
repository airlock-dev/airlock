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
  // Fig specs export a const spec: Fig.Spec = { ... }
  // We do a best-effort extraction of the JSON-like object
  try {
    // Find the main object after "const completionSpec"
    const match = source.match(/const\s+completionSpec\s*(?::\s*\w+(?:\.\w+)*)?\s*=\s*(\{[\s\S]*\})\s*;?\s*$/m);
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
    const parsed = JSON.parse(objStr);
    return {
      name: toolName,
      description: parsed.description,
      options: parsed.options,
      subcommands: parsed.subcommands,
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
      const longName = optNames.find(n => n.startsWith('--')) ?? optNames[0];
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
