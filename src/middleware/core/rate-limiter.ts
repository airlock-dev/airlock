import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { Middleware } from '../types.js';
import { wasDispatched } from './execute.js';

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

/** Remove one admission timestamp (the window may have been re-pruned into a new array since). */
function refund(key: string, timestamp: number): void {
  const timestamps = windows.get(key);
  const index = timestamps?.indexOf(timestamp) ?? -1;
  if (timestamps && index !== -1) timestamps.splice(index, 1);
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
    // parked on an approval) all see an empty window. A call that never reaches the downstream
    // (denied by policy or at approval, rejected by schema validation) is refunded once it settles,
    // so retrying a denied tool cannot use up the budget for allowed ones.
    timestamps.push(now);
    try {
      return await next();
    } finally {
      if (!wasDispatched(ctx)) refund(key, now);
    }
  };
}

/** For testing */
export function resetRateLimiterState(): void {
  windows.clear();
}
