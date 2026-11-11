import { escapeShellArg } from './escaper.js';
import type { CliCommandConfig } from '../../config/schema.js';

function stringifyParamValue(paramName: string, value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value.toString();
  throw new Error(`Parameter "${paramName}" must be a string, number, or boolean`);
}

/** The call's args with each param's configured `default` filled in where the caller gave none. */
function withDefaults(
  config: CliCommandConfig,
  args: Record<string, unknown>
): Record<string, unknown> {
  const resolved = { ...args };
  for (const [paramName, paramConfig] of Object.entries(config.params)) {
    const value = resolved[paramName];
    if ((value === undefined || value === null) && paramConfig.default !== undefined) {
      resolved[paramName] = paramConfig.default;
    }
  }
  return resolved;
}

export function buildCommand(config: CliCommandConfig, callArgs: Record<string, unknown>): string {
  const args = withDefaults(config, callArgs);
  let cmd = config.exec;

  const usedParams = new Set<string>();

  // Drop placeholders for absent optional params, then tidy the gaps they leave. This runs before
  // any value is interpolated so that whitespace inside an argument value is never collapsed.
  cmd = cmd
    .replace(/\{(\w+)\}/g, (match, paramName: string) => {
      const value = args[paramName];
      if (value !== undefined && value !== null) return match;
      if (config.params[paramName]?.required) {
        throw new Error(`Required parameter "${paramName}" is missing`);
      }
      return '';
    })
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Template interpolation: replace the remaining {param} placeholders
  cmd = cmd.replace(/\{(\w+)\}/g, (_match, paramName: string) => {
    usedParams.add(paramName);
    return escapeShellArg(stringifyParamValue(paramName, args[paramName]));
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
      flagParts.push(escapeShellArg(stringifyParamValue(paramName, value)));
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
      flagParts.push(escapeShellArg(stringifyParamValue(paramName, value)));
    }
  }

  if (flagParts.length > 0) {
    cmd = cmd + ' ' + flagParts.join(' ');
  }

  return cmd;
}
