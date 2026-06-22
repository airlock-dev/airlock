import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { Middleware } from '../types.js';
import { extractAirlockContext, requireAirlockReason } from '../../airlock/context.js';
import { isAirlockNonAskTool } from '../../airlock/tools.js';
import { childLogger } from '../../util/logger.js';

const log = childLogger('mw:allowlist');

export function allowlistMiddleware(): Middleware {
  return async (ctx, next) => {
    const extracted = extractAirlockContext(ctx.args);
    ctx.args = extracted.args;
    if (extracted.context) {
      ctx.meta.airlockContext = extracted.context;
    }

    const decision = ctx.deps.allowlist.evaluate(ctx.agentId, ctx.toolName);
    if (decision === 'deny') {
      log.info({ agentId: ctx.agentId, toolName: ctx.toolName }, 'Tool call denied by allowlist');
      ctx.deps.auditLogger.log({
        agent_id: ctx.agentId,
        tool: ctx.toolName,
        args: JSON.stringify(ctx.args),
        result: 'denied',
      });
      throw new McpError(ErrorCode.InvalidRequest, `Tool not available: ${ctx.toolName}`);
    }

    if (decision === 'ask') {
      if (isAirlockNonAskTool(ctx.toolName)) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `${ctx.toolName} cannot be configured with ask. Use allow or deny to avoid recursive approval.`
        );
      }
      const reason = requireAirlockReason(extracted.context);
      if (!reason) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Tool ${ctx.toolName} requires human approval. Retry with _airlock.reason explaining why you are requesting this action now.`
        );
      }
      ctx.meta.needsApproval = true;
    }

    return next();
  };
}
