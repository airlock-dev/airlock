import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
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
  const idx = timestamps.findIndex((t) => t > cutoff);
  return idx === -1 ? [] : timestamps.slice(idx);
}

export function rateLimiterMiddleware(opts: RateLimiterOptions): Middleware {
  const { max_requests, window_ms, per = 'agent' } = opts;

  return async (ctx, next) => {
    const key = getKey(ctx.agentId, ctx.toolName, per);
    const now = Date.now();
    const timestamps = pruneWindow(windows.get(key) ?? [], window_ms, now);
    windows.set(key, timestamps);

    if (timestamps.length >= max_requests) {
      const retryAfterMs = timestamps[0] + window_ms - now;
      throw new ProtocolError(
        ProtocolErrorCode.InvalidRequest,
        `Rate limit exceeded (${max_requests}/${window_ms}ms). Retry after ${Math.ceil(retryAfterMs)}ms.`
      );
    }

    // Count the call when it is admitted, not when it finishes: otherwise concurrent calls (or calls
    // parked on an approval) all see an empty window, and calls that throw are never counted.
    timestamps.push(now);
    return next();
  };
}

/** For testing */
export function resetRateLimiterState(): void {
  windows.clear();
}
