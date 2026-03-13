import { escapeShellArg } from './escaper.js';
import type { CliCommandConfig } from '../../config/schema.js';

export function buildCommand(
  config: CliCommandConfig,
  args: Record<string, unknown>,
): string {
  let cmd = config.exec;

  const usedParams = new Set<string>();

  // Template interpolation: replace {param} placeholders
  cmd = cmd.replace(/\{(\w+)\}/g, (match, paramName: string) => {
    const paramConfig = config.params[paramName];
    const value = args[paramName];

    if (value === undefined || value === null) {
      if (paramConfig?.required) {
        throw new Error(`Required parameter "${paramName}" is missing`);
      }
      return ''; // Remove unreplaced optional placeholders
    }

    usedParams.add(paramName);
    return escapeShellArg(String(value));
  });

  // Append flag-based params not consumed by template interpolation
  const flagParts: string[] = [];

  for (const [paramName, paramConfig] of Object.entries(config.params)) {
    if (usedParams.has(paramName)) continue;

    const value = args[paramName];

    if (value === undefined || value === null) {
      if (paramConfig.required) {
        throw new Error(`Required parameter "${paramName}" is missing`);
      }
      continue;
    }

    if (paramConfig.positional) {
      flagParts.push(escapeShellArg(String(value)));
      continue;
    }

    if (paramConfig.type === 'boolean') {
      if (value === true && paramConfig.flag) {
        flagParts.push(paramConfig.flag);
      }
      continue;
    }

    if (paramConfig.flag) {
      flagParts.push(paramConfig.flag);
      flagParts.push(escapeShellArg(String(value)));
    }
  }

  // Clean up any leftover empty segments from removed placeholders
  cmd = cmd.replace(/\s{2,}/g, ' ').trim();

  if (flagParts.length > 0) {
    cmd = cmd + ' ' + flagParts.join(' ');
  }

  return cmd;
}
