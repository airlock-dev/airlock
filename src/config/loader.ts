import { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { GatewayConfig } from './schema.js';
import { childLogger } from '../util/logger.js';
import type { z } from 'zod';

const log = childLogger('config');

export type Config = z.infer<typeof GatewayConfig>;

export function loadConfig(path: string): Config {
  const raw = readFileSync(path, 'utf-8');
  const parsed = parseYaml(raw);
  const result = GatewayConfig.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid config at ${path}:\n${result.error.toString()}`);
  }
  validateConfig(result.data);
  return result.data;
}

function validateConfig(config: Config): void {
  for (const [agentId, agent] of Object.entries(config.agents)) {
    const { exec } = agent;
    const hasCatchAllDeny = exec.deny.some(p => p === '*');
    if (hasCatchAllDeny && (exec.allow.length > 0 || exec.hitl.length > 0)) {
      log.warn(
        { agentId },
        'exec.deny contains "*" which overrides all exec.allow and exec.hitl patterns — ' +
        'deny is checked first. Remove deny: ["*"] and rely on fail-closed behavior instead.',
      );
    }
  }
}
