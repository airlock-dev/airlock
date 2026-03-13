import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { evaluateExecCommand } from '../../tools/exec.js';
import type { Middleware } from '../types.js';
import { childLogger } from '../../util/logger.js';

const log = childLogger('mw:exec-policy');

export function execPolicyMiddleware(): Middleware {
  return async (ctx, next) => {
    if (ctx.toolName !== 'exec/run') return next();

    const command = ctx.args['command'];
    if (typeof command !== 'string' || !command) {
      throw new McpError(ErrorCode.InvalidParams, 'exec/run requires a string command');
    }

    const cmdDecision = evaluateExecCommand(command, ctx.agentConfig);
    if (cmdDecision === 'deny') {
      log.info({ agentId: ctx.agentId, command }, 'exec command denied by policy');
      ctx.deps.auditLogger.log({
        agent_id: ctx.agentId,
        tool: ctx.toolName,
        args: JSON.stringify(ctx.args),
        result: 'denied',
      });
      throw new McpError(ErrorCode.InvalidRequest, 'Command denied by policy');
    }
    if (cmdDecision === 'ask') {
      ctx.meta.needsApproval = true;
    }

    return next();
  };
}
