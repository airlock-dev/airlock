import type { AirlockCallContext } from '../airlock/context.js';

/**
 * The `args` column for an audit row: the call's arguments plus, under `_airlock`, the approval
 * context the agent gave, the sandbox it ran in and the grant that let it through.
 */
export function serializeAuditArgs(
  args: Record<string, unknown>,
  meta: Record<string, unknown>
): string {
  const sandbox = meta.sandbox_info;
  const context = meta.airlockContext as AirlockCallContext | undefined;
  const grant = meta.approvalGrantId as string | undefined;
  if (!sandbox && !context && !grant) return JSON.stringify(args);
  return JSON.stringify({
    ...args,
    _airlock: { ...(context ?? {}), ...(sandbox ? { sandbox } : {}), ...(grant ? { grant } : {}) },
  });
}
