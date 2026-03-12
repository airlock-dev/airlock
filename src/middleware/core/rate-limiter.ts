import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { Middleware } from '../types.js';

export interface RateLimiterOptions {
  max_requests: number;
  window_ms: number;
  per?: 'agent' | 'tool';
}

const windows = new Map<string, number[]>();

function getKey(agentId: string, toolName: string, per: 'agent' | 'tool'): string {
  return per === 'tool' ? `${agentId}:${toolName}` : agentId;
}

function pruneWindow(timestamps: number[], windowMs: number, now: number): number[] {
  const cutoff = now - windowMs;
  const idx = timestamps.findIndex(t => t > cutoff);
  return idx === -1 ? [] : timestamps.slice(idx);
}

export function rateLimiterMiddleware(opts: RateLimiterOptions): Middleware {
  const { max_requests, window_ms, per = 'agent' } = opts;

  return async (ctx, next) => {
    const key = getKey(ctx.agentId, ctx.toolName, per);
    const now = Date.now();
    let timestamps = windows.get(key) ?? [];
    timestamps = pruneWindow(timestamps, window_ms, now);

    if (timestamps.length >= max_requests) {
      const retryAfterMs = timestamps[0] + window_ms - now;
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Rate limit exceeded (${max_requests}/${window_ms}ms). Retry after ${Math.ceil(retryAfterMs)}ms.`,
      );
    }

    const response = await next();
    timestamps.push(now);
    windows.set(key, timestamps);
    return response;
  };
}

/** For testing */
export function resetRateLimiterState(): void {
  windows.clear();
}
