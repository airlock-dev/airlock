import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { AirlockCallContext } from '../../airlock/context.js';
import type { Middleware, ToolCallResponse } from '../types.js';
import { resolveLimits } from '../../transport/session-limiter.js';

// Concurrently EXECUTING calls per agent. This middleware runs AFTER hitl-gate, so a call parked
// awaiting human approval has not reached here and does not occupy a slot — the cap bounds real
// downstream execution, never the (legitimately long) approval wait.
const executing = new Map<string, number>();

/** For testing */
export function resetExecuteState(): void {
  executing.clear();
}

function serializeAuditArgs(args: Record<string, unknown>, meta: Record<string, unknown>): string {
  const sandbox = meta.sandbox_info;
  const context = meta.airlockContext as AirlockCallContext | undefined;
  if (!sandbox && !context) return JSON.stringify(args);
  return JSON.stringify({
    ...args,
    _airlock: { ...(context ?? {}), ...(sandbox ? { sandbox } : {}) },
  });
}

export function executeMiddleware(): Middleware {
  return async (ctx, _next): Promise<ToolCallResponse> => {
    const { registry, auditLogger } = ctx.deps;
    const limits = resolveLimits(ctx.agentConfig.limits, ctx.deps.securityConfig?.limits);

    // Per-agent execution concurrency cap — one agent cannot monopolize the upstream pool /
    // event loop and starve the others.
    const inFlight = executing.get(ctx.agentId) ?? 0;
    if (inFlight >= limits.maxConcurrentCallsPerAgent) {
      auditLogger.log({
        agent_id: ctx.agentId,
        request_id: ctx.callId,
        tool: ctx.toolName,
        args: serializeAuditArgs(ctx.args, ctx.meta),
        result: 'error',
        error: 'execution concurrency cap exceeded',
        duration_ms: Date.now() - ctx.startedAt,
      });
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Execution concurrency cap reached for agent (${limits.maxConcurrentCallsPerAgent} concurrent calls). Retry shortly.`
      );
    }
    executing.set(ctx.agentId, inFlight + 1);

    // Last checkpoint before handing off to the downstream. If the downstream hangs, THIS is the
    // final row for the request_id — a 'dispatched' with no matching terminal row means the call is
    // stuck in the downstream (visible even when callExecutionTimeoutMs is 0 and it never returns).
    auditLogger.log({
      agent_id: ctx.agentId,
      request_id: ctx.callId,
      tool: ctx.toolName,
      args: serializeAuditArgs(ctx.args, ctx.meta),
      result: 'dispatched',
    });

    try {
      const callResult = await withExecutionTimeout(
        registry.call(ctx.toolName, ctx.args, ctx.agentId, ctx.meta),
        limits.callExecutionTimeoutMs,
        ctx.toolName
      );

      const duration = Date.now() - ctx.startedAt;
      auditLogger.log({
        agent_id: ctx.agentId,
        request_id: ctx.callId,
        tool: ctx.toolName,
        args: serializeAuditArgs(ctx.args, ctx.meta),
        result: 'success',
        duration_ms: duration,
      });

      return {
        result: callResult,
        text: JSON.stringify(callResult),
      };
    } catch (err) {
      const duration = Date.now() - ctx.startedAt;
      const error = err instanceof Error ? err.message : String(err);
      auditLogger.log({
        agent_id: ctx.agentId,
        request_id: ctx.callId,
        tool: ctx.toolName,
        args: serializeAuditArgs(ctx.args, ctx.meta),
        result: 'error',
        error,
        duration_ms: duration,
      });
      // Preserve an already-typed McpError (e.g. the execution timeout) instead of masking it.
      if (err instanceof McpError) throw err;
      throw new McpError(ErrorCode.InternalError, error);
    } finally {
      const n = (executing.get(ctx.agentId) ?? 1) - 1;
      if (n <= 0) executing.delete(ctx.agentId);
      else executing.set(ctx.agentId, n);
    }
  };
}

/**
 * Enforce a deadline on a single downstream tool execution. Applies ONLY to the actual upstream
 * call — the HITL approval wait happens in an earlier middleware (hitl-gate) and is never clocked
 * here, so an async task can wait hours for approval and still get its full execution budget.
 * timeoutMs === 0 disables the deadline entirely (the default, so genuinely long downstream calls
 * are never severed).
 */
function withExecutionTimeout<T>(promise: Promise<T>, timeoutMs: number, toolName: string): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new McpError(
          ErrorCode.InternalError,
          `Tool execution for "${toolName}" exceeded ${timeoutMs}ms and was aborted.`
        )
      );
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    );
  });
}
