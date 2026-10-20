export const AIRLOCK_PROVIDER_ID = 'airlock';

export const AIRLOCK_ASK_USER_TOOL = 'airlock/ask_user';
export const AIRLOCK_NOTIFY_USER_TOOL = 'airlock/notify_user';
export const AIRLOCK_LOG_TOOL = 'airlock/log';
export const AIRLOCK_STATUS_TOOL = 'airlock/status';
export const AIRLOCK_LIST_PROVIDER_TOOLS_TOOL = 'airlock/list_provider_tools';
export const AIRLOCK_REQUEST_APPROVAL_TOOL = 'airlock/request_approval';
export const AIRLOCK_AWAIT_APPROVAL_TOOL = 'airlock/await_approval';

export const AIRLOCK_TOOL_NAMES = [
  AIRLOCK_ASK_USER_TOOL,
  AIRLOCK_NOTIFY_USER_TOOL,
  AIRLOCK_LOG_TOOL,
  AIRLOCK_STATUS_TOOL,
  AIRLOCK_LIST_PROVIDER_TOOLS_TOOL,
  AIRLOCK_REQUEST_APPROVAL_TOOL,
  AIRLOCK_AWAIT_APPROVAL_TOOL,
] as const;

/**
 * Approval-plumbing tools. Any agent with at least one `ask` rule can use them without an explicit
 * allow (an explicit deny still wins): they only ever create or read approvals, never grant anything.
 */
export const AIRLOCK_APPROVAL_TOOLS = [
  AIRLOCK_REQUEST_APPROVAL_TOOL,
  AIRLOCK_AWAIT_APPROVAL_TOOL,
] as const;

export function isAirlockApprovalTool(toolName: string): boolean {
  return (AIRLOCK_APPROVAL_TOOLS as readonly string[]).includes(toolName);
}

export function isAirlockTool(toolName: string): boolean {
  return (AIRLOCK_TOOL_NAMES as readonly string[]).includes(toolName);
}

export const AIRLOCK_NON_ASK_TOOLS = [
  AIRLOCK_ASK_USER_TOOL,
  AIRLOCK_NOTIFY_USER_TOOL,
  AIRLOCK_LOG_TOOL,
  AIRLOCK_REQUEST_APPROVAL_TOOL,
  AIRLOCK_AWAIT_APPROVAL_TOOL,
] as const;

export function isAirlockNonAskTool(toolName: string): boolean {
  return (AIRLOCK_NON_ASK_TOOLS as readonly string[]).includes(toolName);
}
