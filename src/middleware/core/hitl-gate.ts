import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { Middleware } from '../types.js';
import { formatNotifyEvent } from '../../hitl/formatter.js';
import { childLogger } from '../../util/logger.js';

const log = childLogger('mw:hitl-gate');

export function hitlGateMiddleware(): Middleware {
  return async (ctx, next) => {
    // Notify-only: send a fire-and-forget notification, then proceed without blocking
    if (ctx.meta.notifyOnly && !ctx.meta.needsApproval) {
      const { hitlBatcher, auditLogger } = ctx.deps;

      auditLogger.log({
        agent_id: ctx.agentId,
        tool: ctx.toolName,
        args: JSON.stringify(ctx.args),
        result: 'notify',
      });

      // Send notification without creating a ticket (no approval needed)
      hitlBatcher.add({
        id: `notify-${Date.now()}`,
        code: 'NOTIFY',
        agentId: ctx.agentId,
        tool: ctx.toolName,
        args: ctx.args,
        timeoutMs: 0,
        notifyOnly: true,
      });

      return next();
    }

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
        agent_id: ctx.agentId,
        tool: ctx.toolName,
        args: JSON.stringify(ctx.args),
        result: 'hitl_denied',
      });
      throw new McpError(ErrorCode.InvalidRequest, 'Request denied by operator');
    }
    if (result === 'timeout') {
      auditLogger.log({
        agent_id: ctx.agentId,
        tool: ctx.toolName,
        args: JSON.stringify(ctx.args),
        result: 'hitl_timeout',
      });
      throw new McpError(
        ErrorCode.InvalidRequest,
        'Approval timed out. Re-request when operator is available.'
      );
    }

    return next();
  };
}
