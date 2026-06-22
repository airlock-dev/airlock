import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { AirlockCallContext } from '../../airlock/context.js';
import type { Middleware, ToolCallResponse } from '../types.js';

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

    try {
      const callResult = await registry.call(ctx.toolName, ctx.args, ctx.agentId, ctx.meta);

      const duration = Date.now() - ctx.startedAt;
      auditLogger.log({
        agent_id: ctx.agentId,
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
        tool: ctx.toolName,
        args: serializeAuditArgs(ctx.args, ctx.meta),
        result: 'error',
        error,
        duration_ms: duration,
      });
      throw new McpError(ErrorCode.InternalError, error);
    }
  };
}
