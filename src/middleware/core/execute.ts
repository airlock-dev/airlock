import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { Middleware, ToolCallResponse } from '../types.js';

export function executeMiddleware(): Middleware {
  return async (ctx, _next): Promise<ToolCallResponse> => {
    const { registry, auditLogger } = ctx.deps;

    try {
      const callResult = await registry.call(ctx.toolName, ctx.args, ctx.agentId);

      const duration = Date.now() - ctx.startedAt;
      auditLogger.log({
        agent_id: ctx.agentId,
        tool: ctx.toolName,
        args: JSON.stringify(ctx.args),
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
        args: JSON.stringify(ctx.args),
        result: 'error',
        error,
        duration_ms: duration,
      });
      throw new McpError(ErrorCode.InternalError, error);
    }
  };
}
