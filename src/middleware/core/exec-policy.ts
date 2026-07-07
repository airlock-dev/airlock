import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { evaluateExecCommand } from '../../tools/exec.js';
import type { Middleware } from '../types.js';
import { childLogger } from '../../util/logger.js';

const log = childLogger('mw:exec-policy');

export function execPolicyMiddleware(): Middleware {
  return async (ctx, next) => {
    const resolvedToolName =
      ctx.deps.registry.resolveToolName?.(ctx.toolName, ctx.agentId) ??
      ctx.agentConfig.tool_overrides?.[ctx.toolName]?.alias_of ??
      ctx.toolName;
    if (resolvedToolName !== 'exec/run') return next();

    const command = ctx.args['command'];
    if (typeof command !== 'string' || !command) {
      throw new McpError(ErrorCode.InvalidParams, 'exec/run requires a string command');
    }
    const cwd = ctx.args['cwd'];
    if (cwd !== undefined && (typeof cwd !== 'string' || cwd.includes('\0'))) {
      throw new McpError(ErrorCode.InvalidParams, 'exec/run cwd must be a valid string');
    }
    const timeoutMs = ctx.args['timeout_ms'];
    if (
      timeoutMs !== undefined &&
      (typeof timeoutMs !== 'number' ||
        !Number.isFinite(timeoutMs) ||
        timeoutMs <= 0 ||
        timeoutMs > ctx.agentConfig.exec.default_timeout_ms)
    ) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'exec/run timeout_ms must be positive and no greater than exec.default_timeout_ms'
      );
    }

    const cmdDecision = evaluateExecCommand(command, ctx.agentConfig);
    if (cmdDecision === 'deny') {
      log.info({ agentId: ctx.agentId, command }, 'exec command denied by policy');
      ctx.deps.auditLogger.log({
        agent_id: ctx.agentId,
        request_id: ctx.callId,
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
