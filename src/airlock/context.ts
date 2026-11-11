export const AIRLOCK_CONTEXT_KEY = '_airlock';
export const AIRLOCK_REASON_MAX_LENGTH = 500;

export interface AirlockCallContext {
  reason?: string;
  note?: string;
}

export function extractAirlockContext(args: Record<string, unknown>): {
  args: Record<string, unknown>;
  context?: AirlockCallContext;
} {
  if (!(AIRLOCK_CONTEXT_KEY in args)) return { args };

  // The key is Airlock's own: strip it even when malformed, so it never reaches the upstream tool.
  const { [AIRLOCK_CONTEXT_KEY]: raw, ...cleanArgs } = args;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { args: cleanArgs };
  }

  const source = raw as Record<string, unknown>;
  const context: AirlockCallContext = {};
  if (typeof source.reason === 'string') {
    context.reason = clampHumanText(source.reason);
  }
  if (typeof source.note === 'string') {
    context.note = clampHumanText(source.note);
  }

  return {
    args: cleanArgs,
    ...(context.reason || context.note ? { context } : {}),
  };
}

export function requireAirlockReason(context: AirlockCallContext | undefined): string | undefined {
  const reason = context?.reason?.trim();
  return reason ? reason : undefined;
}

function clampHumanText(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > AIRLOCK_REASON_MAX_LENGTH
    ? trimmed.slice(0, AIRLOCK_REASON_MAX_LENGTH)
    : trimmed;
}
