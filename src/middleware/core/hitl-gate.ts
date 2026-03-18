import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { SandboxDisplayInfo } from '../../sandbox/index.js';
import type { Middleware } from '../types.js';

function serializeAuditArgs(args: Record<string, unknown>, meta: Record<string, unknown>): string {
  const sandbox = meta.sandbox_info;
  if (!sandbox) return JSON.stringify(args);
  return JSON.stringify({ ...args, _airlock: { sandbox } });
}

export function hitlGateMiddleware(): Middleware {
  return async (ctx, next) => {
    if (!ctx.meta.needsApproval) return next();

    const { hitlEngine, hitlBatcher, auditLogger } = ctx.deps;
    const sandboxInfo = ctx.meta.sandbox_info as SandboxDisplayInfo | undefined;
    const ticket = hitlEngine.create({
      agentId: ctx.agentId,
      tool: ctx.toolName,
      args: ctx.args,
      sandbox: sandboxInfo,
    });

    hitlBatcher.add({
      id: ticket.id,
      code: ticket.code,
      agentId: ctx.agentId,
      tool: ctx.toolName,
      args: ctx.args,
      ...(sandboxInfo ? { sandbox: sandboxInfo } : {}),
      timeoutMs: hitlEngine.timeoutMs,
    });

    const result = await ticket.result;

    if (result === 'denied') {
      auditLogger.log({
        agent_id: ctx.agentId,
        tool: ctx.toolName,
        args: serializeAuditArgs(ctx.args, ctx.meta),
        result: 'hitl_denied',
      });
      throw new McpError(ErrorCode.InvalidRequest, 'Request denied by operator');
    }
    if (result === 'timeout') {
      auditLogger.log({
        agent_id: ctx.agentId,
        tool: ctx.toolName,
        args: serializeAuditArgs(ctx.args, ctx.meta),
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
