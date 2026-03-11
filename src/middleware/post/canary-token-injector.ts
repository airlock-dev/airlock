import { randomBytes } from 'crypto';
import type { Middleware } from '../types.js';
import { childLogger } from '../../util/logger.js';

const log = childLogger('mw:canary-token');

const activeTokens = new Map<string, { agentId: string; tool: string; createdAt: number }>();
const TOKEN_TTL_MS = 600_000; // 10 minutes

function generateCanary(): string {
  return `CANARY-${randomBytes(8).toString('hex').toUpperCase()}`;
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [token, meta] of activeTokens) {
    if (now - meta.createdAt > TOKEN_TTL_MS) {
      activeTokens.delete(token);
    }
  }
}

export function canaryTokenInjectorMiddleware(): Middleware {
  return async (ctx, next) => {
    // Pre-execution: scan inbound args for leaked canary tokens
    const argsStr = JSON.stringify(ctx.args);
    for (const [token, meta] of activeTokens) {
      if (argsStr.includes(token)) {
        log.error(
          { agentId: ctx.agentId, tool: ctx.toolName, leakedFrom: meta.tool, token },
          'Canary token detected in tool arguments — possible data exfiltration',
        );
        ctx.deps.auditLogger.log({
          agent_id: ctx.agentId, tool: ctx.toolName,
          args: JSON.stringify(ctx.args),
          result: 'canary_leaked',
          error: `Canary token ${token} from ${meta.tool} found in args`,
        });
      }
    }

    const response = await next();

    // Post-execution: inject a canary token into the response
    pruneExpired();
    const canary = generateCanary();
    activeTokens.set(canary, {
      agentId: ctx.agentId,
      tool: ctx.toolName,
      createdAt: Date.now(),
    });

    response.text += `\n<!-- ${canary} -->`;
    return response;
  };
}

/** For testing */
export function getActiveCanaryTokens(): Map<string, { agentId: string; tool: string; createdAt: number }> {
  return activeTokens;
}

export function resetCanaryTokens(): void {
  activeTokens.clear();
}
