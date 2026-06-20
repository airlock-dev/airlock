import { isDeepStrictEqual } from 'util';
import type { ToolArgConstraintConfig } from '../../config/schema.js';
import type { Middleware, ToolCallResponse } from '../types.js';

type ToolArgPolicy = Record<string, ToolArgConstraintConfig[]>;
type MatcherKey = 'equals' | 'allow' | 'glob_allow' | 'each_allow';

const MISSING = Symbol('missing');

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function hasConstraintKey(constraint: ToolArgConstraintConfig, key: MatcherKey): boolean {
  return Object.prototype.hasOwnProperty.call(constraint, key);
}

function formatValue(value: unknown): string {
  const text = typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function formatAllowed(constraint: ToolArgConstraintConfig): string {
  const source = constraint.value_set ?? constraint.label;
  const exposeValues = constraint.expose_values ?? true;
  const values = constraint.allow ?? constraint.glob_allow ?? constraint.each_allow ?? [];

  if (source && !exposeValues) {
    return `${source} (${values.length} values)`;
  }

  if (hasConstraintKey(constraint, 'equals')) {
    const label = constraint.label ? ` (${constraint.label})` : '';
    return `${formatValue(constraint.equals)}${label}`;
  }

  const visibleValues = values.slice(0, 5);
  const formatted = visibleValues.map(formatValue).join(', ');
  const suffix = values.length > visibleValues.length ? `, ... (${values.length} total)` : '';
  const label = constraint.label ? ` (${constraint.label})` : '';
  return `${formatted}${suffix}${label}`;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(a, b);
}

// `*` is greedy and matches across `/`; this is intentional for nested git refs.
function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

// US/E.164-oriented: store allowlist numbers as +<country><number> for non-US matching.
function normalizePhone(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const digits = value.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return value.startsWith('+') ? `+${digits}` : digits;
}

function normalizeValue(
  value: unknown,
  normalizers: ToolArgConstraintConfig['normalize']
): unknown {
  if (!normalizers || Array.isArray(value)) return value;

  let next = value;
  for (const normalizer of normalizers) {
    if (normalizer === 'phone') {
      next = normalizePhone(next);
    } else if (typeof next === 'string' && normalizer === 'trim') {
      next = next.trim();
    } else if (typeof next === 'string' && normalizer === 'lower') {
      next = next.toLowerCase();
    } else if (typeof next === 'string' && normalizer === 'email') {
      next = next.trim().toLowerCase();
    }
  }
  return next;
}

function normalizeList(
  values: unknown[],
  normalizers: ToolArgConstraintConfig['normalize']
): unknown[] {
  return values.map((value) => normalizeValue(value, normalizers));
}

function resolvePath(root: unknown, path: string): unknown {
  let values: unknown[] = [root];

  for (const segment of path.split('.').filter(Boolean)) {
    const spreadArray = segment.endsWith('[]');
    const key = spreadArray ? segment.slice(0, -2) : segment;
    const nextValues: unknown[] = [];

    for (const value of values) {
      const candidates = Array.isArray(value) ? value : [value];
      for (const candidate of candidates) {
        if (
          candidate &&
          typeof candidate === 'object' &&
          Object.prototype.hasOwnProperty.call(candidate, key)
        ) {
          const next = (candidate as Record<string, unknown>)[key];
          if (spreadArray && Array.isArray(next)) {
            for (const item of next as unknown[]) {
              nextValues.push(item);
            }
          } else {
            nextValues.push(next);
          }
        }
      }
    }

    if (nextValues.length === 0) return MISSING;
    values = nextValues;
  }

  return values.length === 1 ? values[0] : values;
}

function resolveArgValue(args: Record<string, unknown>, argName: string, path?: string): unknown {
  if (path) return resolvePath(args, path);
  return hasOwn(args, argName) ? args[argName] : MISSING;
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
  const merged: ToolArgPolicy = {};

  for (const source of [base, override]) {
    for (const [argName, constraints] of Object.entries(source ?? {})) {
      merged[argName] = [...(merged[argName] ?? []), ...constraints];
    }
  }

  return merged;
}

export function resolveArgPolicy(
  agentConfig: {
    arg_policy?: Record<string, ToolArgPolicy>;
    tool_overrides?: Record<string, { alias_of?: string; args?: ToolArgPolicy }>;
  },
  toolName: string
): ToolArgPolicy {
  const canonicalToolName = agentConfig.tool_overrides?.[toolName]?.alias_of;
  return mergePolicies(
    mergePolicies(
      canonicalToolName ? agentConfig.arg_policy?.[canonicalToolName] : undefined,
      agentConfig.arg_policy?.[toolName]
    ),
    agentConfig.tool_overrides?.[toolName]?.args
  );
}

function passesConstraint(actual: unknown, constraint: ToolArgConstraintConfig): boolean {
  if (hasConstraintKey(constraint, 'equals')) {
    return valuesEqual(
      normalizeValue(actual, constraint.normalize),
      normalizeValue(constraint.equals, constraint.normalize)
    );
  }

  if (hasConstraintKey(constraint, 'allow')) {
    const normalizedActual = normalizeValue(actual, constraint.normalize);
    return normalizeList(constraint.allow ?? [], constraint.normalize).some((allowed) =>
      valuesEqual(normalizedActual, allowed)
    );
  }

  if (hasConstraintKey(constraint, 'glob_allow')) {
    const normalizedActual = normalizeValue(actual, constraint.normalize);
    if (typeof normalizedActual !== 'string') return false;
    return (constraint.glob_allow ?? []).some((pattern) => globMatches(pattern, normalizedActual));
  }

  if (hasConstraintKey(constraint, 'each_allow')) {
    const actualValues = Array.isArray(actual) ? actual : [actual];
    const allowedValues = normalizeList(constraint.each_allow ?? [], constraint.normalize);
    return actualValues.every((value) => {
      const normalizedValue = normalizeValue(value, constraint.normalize);
      return allowedValues.some((allowed) => valuesEqual(normalizedValue, allowed));
    });
  }

  return false;
}

function retryInstruction(constraint: ToolArgConstraintConfig): string {
  if (hasConstraintKey(constraint, 'equals')) return 'Retry with that value.';
  if (hasConstraintKey(constraint, 'glob_allow')) return 'Retry with an allowed pattern match.';
  return 'Retry with one of the allowed values.';
}

export function argPolicyMiddleware(): Middleware {
  return async (ctx, next) => {
    const policy = resolveArgPolicy(ctx.agentConfig, ctx.toolName);
    const entries = Object.entries(policy);
    if (entries.length === 0) return next();

    for (const [argName, constraints] of entries) {
      for (const constraint of constraints) {
        const actual = resolveArgValue(ctx.args, argName, constraint.path);
        const required = constraint.required ?? true;
        const displayName = constraint.path ?? argName;

        if (actual === MISSING) {
          if (!required) continue;

          const message =
            `${displayName} is required by policy for ${ctx.toolName}. ` +
            `Allowed ${displayName}: ${formatAllowed(constraint)}. ${retryInstruction(constraint)}`;
          ctx.deps.auditLogger.log({
            agent_id: ctx.agentId,
            tool: ctx.toolName,
            args: JSON.stringify(ctx.args),
            result: 'arg_policy_denied',
            error: message,
          });
          return violationResponse(message);
        }

        if (!passesConstraint(actual, constraint)) {
          const message =
            `${displayName} ${formatValue(actual)} is not permitted for ${ctx.toolName}. ` +
            `Allowed ${displayName}: ${formatAllowed(constraint)}. ${retryInstruction(constraint)}`;
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
    }

    return next();
  };
}
