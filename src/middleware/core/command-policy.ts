import type { CommandPolicyRuleConfig } from '../../config/schema.js';
import type { Middleware, ToolCallResponse } from '../types.js';
import { childLogger } from '../../util/logger.js';

const log = childLogger('mw:command-policy');

export type CommandDecision = 'allow' | 'ask' | 'deny';

/**
 * Anchored glob match against a command string. `*` matches any run of characters (including
 * spaces, slashes, and the empty string); a pattern with no `*` is an exact match. Unlike the
 * tool-name matcher (prefix-only), this matches mid-string so patterns like `call *query-* *`
 * work against `call --json query-trends {...}`.
 */
function matchesGlob(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

/** Precedence: deny > ask > allow; anything unmatched falls to `default` (deny if unset). */
export function evaluateCommandPolicy(command: string, rule: CommandPolicyRuleConfig): CommandDecision {
  if (rule.deny.some((p) => matchesGlob(p, command))) return 'deny';
  if (rule.ask.some((p) => matchesGlob(p, command))) return 'ask';
  if (rule.allow.some((p) => matchesGlob(p, command))) return 'allow';
  return rule.default ?? 'deny';
}

function truncate(value: string): string {
  return value.length > 200 ? `${value.slice(0, 197)}...` : value;
}

function violationResponse(message: string): ToolCallResponse {
  return {
    result: { content: [{ type: 'text', text: message }], isError: true },
    text: message,
  };
}

/**
 * General command router for tools whose privilege lives inside a string argument. For a tool with
 * a `command_policy`, each configured arg's string value is routed to allow/ask/deny by glob match.
 * `deny` returns a tool error; `ask` sets `ctx.meta.needsApproval` so the HITL gate takes over.
 * Deny wins: a single denied arg short-circuits the call. Tools without a policy pass through.
 */
export function commandPolicyMiddleware(): Middleware {
  return async (ctx, next) => {
    const policies = ctx.agentConfig.command_policy;
    if (!policies) return next();

    const resolvedToolName =
      ctx.deps.registry.resolveToolName?.(ctx.toolName, ctx.agentId) ??
      ctx.agentConfig.tool_overrides?.[ctx.toolName]?.alias_of ??
      ctx.toolName;
    const policy = policies[ctx.toolName] ?? policies[resolvedToolName];
    if (!policy) return next();

    let needsApproval = false;

    for (const [argName, rule] of Object.entries(policy)) {
      const value = ctx.args[argName];

      if (typeof value !== 'string') {
        const message = `${argName} must be a string command for ${ctx.toolName}.`;
        ctx.deps.auditLogger.log({
          agent_id: ctx.agentId,
          request_id: ctx.callId,
          tool: ctx.toolName,
          args: JSON.stringify(ctx.args),
          result: 'command_policy_denied',
          error: message,
        });
        return violationResponse(message);
      }

      const decision = evaluateCommandPolicy(value, rule);

      if (decision === 'deny') {
        const message = `Command "${truncate(value)}" is not permitted for ${ctx.toolName}.`;
        log.info({ agentId: ctx.agentId, tool: ctx.toolName, arg: argName }, 'command denied by policy');
        ctx.deps.auditLogger.log({
          agent_id: ctx.agentId,
          request_id: ctx.callId,
          tool: ctx.toolName,
          args: JSON.stringify(ctx.args),
          result: 'command_policy_denied',
          error: message,
        });
        return violationResponse(message);
      }

      if (decision === 'ask') {
        needsApproval = true;
        ctx.deps.auditLogger.log({
          agent_id: ctx.agentId,
          request_id: ctx.callId,
          tool: ctx.toolName,
          args: JSON.stringify(ctx.args),
          result: 'command_policy_ask',
        });
      }
    }

    if (needsApproval) ctx.meta.needsApproval = true;

    return next();
  };
}
