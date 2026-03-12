import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { Middleware } from '../types.js';

export function hitlGateMiddleware(): Middleware {
  return async (ctx, next) => {
    if (!ctx.meta.needsApproval) return next();

    const { hitlEngine, hitlBatcher, auditLogger } = ctx.deps;
    const ticket = hitlEngine.create({ agentId: ctx.agentId, tool: ctx.toolName, args: ctx.args });

    hitlBatcher.add({
      id: ticket.id,
      code: ticket.code,
      agentId: ctx.agentId,
      tool: ctx.toolName,
      args: ctx.args,
      timeoutMs: hitlEngine.timeoutMs,
    });

    const result = await ticket.result;

    if (result === 'denied') {
      auditLogger.log({
        agent_id: ctx.agentId, tool: ctx.toolName,
        args: JSON.stringify(ctx.args), result: 'hitl_denied',
      });
      throw new McpError(ErrorCode.InvalidRequest, 'Request denied by operator');
    }
    if (result === 'timeout') {
      auditLogger.log({
        agent_id: ctx.agentId, tool: ctx.toolName,
        args: JSON.stringify(ctx.args), result: 'hitl_timeout',
      });
      throw new McpError(ErrorCode.InvalidRequest, 'Approval timed out. Re-request when operator is available.');
    }

    return next();
  };
}
