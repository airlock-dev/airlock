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

    // If the transport provides an abort signal, race the HITL promise against it
    // so we don't execute a tool on a dead session.
    let result: Awaited<typeof ticket.result> | 'disconnected';
    if (ctx.signal && !ctx.signal.aborted) {
      result = await Promise.race([
        ticket.result,
        new Promise<'disconnected'>((resolve) => {
          if (ctx.signal!.aborted) {
            resolve('disconnected');
          } else {
            ctx.signal!.addEventListener('abort', () => resolve('disconnected'), { once: true });
          }
        }),
      ]);
    } else if (ctx.signal?.aborted) {
      // Already disconnected before we even started waiting
      result = 'disconnected';
    } else {
      result = await ticket.result;
    }

    if (result === 'disconnected') {
      hitlEngine.cancel(ticket.id);
      auditLogger.log({
        agent_id: ctx.agentId,
        tool: ctx.toolName,
        args: JSON.stringify(ctx.args),
        result: 'hitl_disconnected',
      });
      throw new McpError(ErrorCode.InvalidRequest, 'Session disconnected while awaiting approval');
    }

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
