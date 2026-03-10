import { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { GatewayConfig } from './schema.js';
import type { z } from 'zod';

export type Config = z.infer<typeof GatewayConfig>;

export function loadConfig(path: string): Config {
  const raw = readFileSync(path, 'utf-8');
  const parsed = parseYaml(raw);
  const result = GatewayConfig.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid config at ${path}:\n${result.error.toString()}`);
  }
  return result.data;
}
