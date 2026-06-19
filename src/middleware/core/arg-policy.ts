import { isDeepStrictEqual } from 'util';
import type { ToolArgConstraintConfig } from '../../config/schema.js';
import type { Middleware, ToolCallResponse } from '../types.js';

type ToolArgPolicy = Record<string, ToolArgConstraintConfig>;

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function hasConstraintKey(constraint: ToolArgConstraintConfig, key: 'equals' | 'allow'): boolean {
  return Object.prototype.hasOwnProperty.call(constraint, key);
}

function formatValue(value: unknown): string {
  const text = typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function formatAllowed(constraint: ToolArgConstraintConfig): string {
  if (hasConstraintKey(constraint, 'equals')) {
    const label = constraint.label ? ` (${constraint.label})` : '';
    return `${formatValue(constraint.equals)}${label}`;
  }

  const values = constraint.allow ?? [];
  const formatted = values.map(formatValue).join(', ');
  const label = constraint.label ? ` (${constraint.label})` : '';
  return `${formatted}${label}`;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(a, b);
}

function violationResponse(message: string): ToolCallResponse {
  return {
    result: { content: [{ type: 'text', text: message }], isError: true },
    text: message,
  };
}

function mergePolicies(
  base: ToolArgPolicy | undefined,
  override: ToolArgPolicy | undefined
): ToolArgPolicy {
  return {
    ...(base ?? {}),
    ...(override ?? {}),
  };
}

export function resolveArgPolicy(
  agentConfig: {
    arg_policy?: Record<string, ToolArgPolicy>;
    tool_overrides?: Record<string, { args?: ToolArgPolicy }>;
  },
  toolName: string
): ToolArgPolicy {
  return mergePolicies(
    agentConfig.arg_policy?.[toolName],
    agentConfig.tool_overrides?.[toolName]?.args
  );
}

export function argPolicyMiddleware(): Middleware {
  return async (ctx, next) => {
    const policy = resolveArgPolicy(ctx.agentConfig, ctx.toolName);
    const entries = Object.entries(policy);
    if (entries.length === 0) return next();

    for (const [argName, constraint] of entries) {
      if (!hasOwn(ctx.args, argName)) {
        const message =
          `${argName} is required by policy for ${ctx.toolName}. ` +
          `Allowed ${argName}: ${formatAllowed(constraint)}. Retry with that value.`;
        ctx.deps.auditLogger.log({
          agent_id: ctx.agentId,
          tool: ctx.toolName,
          args: JSON.stringify(ctx.args),
          result: 'arg_policy_denied',
          error: message,
        });
        return violationResponse(message);
      }

      const actual = ctx.args[argName];
      if (hasConstraintKey(constraint, 'equals') && !valuesEqual(actual, constraint.equals)) {
        const message =
          `${argName} ${formatValue(actual)} is not permitted for ${ctx.toolName}. ` +
          `Allowed ${argName}: ${formatAllowed(constraint)}. Retry with that value.`;
        ctx.deps.auditLogger.log({
          agent_id: ctx.agentId,
          tool: ctx.toolName,
          args: JSON.stringify(ctx.args),
          result: 'arg_policy_denied',
          error: message,
        });
        return violationResponse(message);
      }

      if (
        hasConstraintKey(constraint, 'allow') &&
        !(constraint.allow ?? []).some((allowed) => valuesEqual(actual, allowed))
      ) {
        const message =
          `${argName} ${formatValue(actual)} is not permitted for ${ctx.toolName}. ` +
          `Allowed ${argName}: ${formatAllowed(constraint)}. Retry with one of the allowed values.`;
        ctx.deps.auditLogger.log({
          agent_id: ctx.agentId,
          tool: ctx.toolName,
          args: JSON.stringify(ctx.args),
          result: 'arg_policy_denied',
          error: message,
        });
        return violationResponse(message);
      }
    }

    return next();
  };
}
