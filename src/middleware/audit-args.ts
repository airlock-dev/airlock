import type { AirlockCallContext } from '../airlock/context.js';
import type { AuditUploadSummary } from '../uploads/resolve.js';

/**
 * The `args` column for an audit row: the call's arguments plus, under `_airlock`, the approval
 * context the agent gave, the sandbox it ran in, the grant that let it through, and verified
 * metadata for any staged file uploads referenced by the call.
 */
export function serializeAuditArgs(
  args: Record<string, unknown>,
  meta: Record<string, unknown>
): string {
  const sandbox = meta.sandbox_info;
  const context = meta.airlockContext as AirlockCallContext | undefined;
  const grant = meta.approvalGrantId as string | undefined;
  const uploads = meta.uploads as AuditUploadSummary[] | undefined;
  if (!sandbox && !context && !grant && !uploads?.length) return JSON.stringify(args);
  return JSON.stringify({
    ...args,
    _airlock: {
      ...(context ?? {}),
      ...(sandbox ? { sandbox } : {}),
      ...(grant ? { grant } : {}),
      ...(uploads?.length ? { uploads } : {}),
    },
  });
}
