import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { Middleware } from '../types.js';
import { childLogger } from '../../util/logger.js';

const log = childLogger('mw:allowlist');

export function allowlistMiddleware(): Middleware {
  return async (ctx, next) => {
    const decision = ctx.deps.allowlist.evaluate(ctx.agentId, ctx.toolName);
    if (decision === 'deny') {
      log.info({ agentId: ctx.agentId, toolName: ctx.toolName }, 'Tool call denied by allowlist');
      ctx.deps.auditLogger.log({
        agent_id: ctx.agentId, tool: ctx.toolName,
        args: JSON.stringify(ctx.args), result: 'denied',
      });
      throw new McpError(ErrorCode.InvalidRequest, `Tool not available: ${ctx.toolName}`);
    }

    if (decision === 'ask') {
      ctx.meta.needsApproval = true;
    }

    return next();
  };
}
