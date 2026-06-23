import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { SandboxDisplayInfo } from '../../sandbox/index.js';
import type { Middleware, ToolCallResponse } from '../types.js';

function errorResponse(message: string): ToolCallResponse {
  return {
    result: { content: [{ type: 'text', text: message }], isError: true },
    text: message,
  };
}

function serializeAuditArgs(args: Record<string, unknown>, meta: Record<string, unknown>): string {
  const sandbox = meta.sandbox_info;
  if (!sandbox) return JSON.stringify(args);
  return JSON.stringify({ ...args, _airlock: { sandbox } });
}

function redactApprovalArgs(
  auditLogger: { redactArgs?: (args: Record<string, unknown>) => Record<string, unknown> },
  args: Record<string, unknown>
): Record<string, unknown> {
  return auditLogger.redactArgs?.(args) ?? args;
}

export function hitlGateMiddleware(): Middleware {
  return async (ctx, next) => {
    if (!ctx.meta.needsApproval) return next();

    const { hitlEngine, hitlBatcher, auditLogger } = ctx.deps;
    const sandboxInfo = ctx.meta.sandbox_info as SandboxDisplayInfo | undefined;
    const approvalArgs = redactApprovalArgs(auditLogger, ctx.args);
    const ticket = hitlEngine.create({
      agentId: ctx.agentId,
      tool: ctx.toolName,
      args: approvalArgs,
      sandbox: sandboxInfo,
    });

    hitlBatcher.add({
      id: ticket.id,
      code: ticket.code,
      agentId: ctx.agentId,
      tool: ctx.toolName,
      args: approvalArgs,
      ...(sandboxInfo ? { sandbox: sandboxInfo } : {}),
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
        args: serializeAuditArgs(ctx.args, ctx.meta),
        result: 'hitl_denied',
      });
      return errorResponse('Request denied by operator');
    }
    if (result === 'timeout') {
      auditLogger.log({
        agent_id: ctx.agentId,
        tool: ctx.toolName,
        args: serializeAuditArgs(ctx.args, ctx.meta),
        result: 'hitl_timeout',
      });
      return errorResponse('Approval timed out. Re-request when operator is available.');
    }

    return next();
  };
}
