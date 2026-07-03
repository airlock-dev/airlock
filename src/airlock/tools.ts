export const AIRLOCK_PROVIDER_ID = 'airlock';

export const AIRLOCK_ASK_USER_TOOL = 'airlock/ask_user';
export const AIRLOCK_NOTIFY_USER_TOOL = 'airlock/notify_user';
export const AIRLOCK_LOG_TOOL = 'airlock/log';
export const AIRLOCK_STATUS_TOOL = 'airlock/status';
export const AIRLOCK_LIST_PROVIDER_TOOLS_TOOL = 'airlock/list_provider_tools';

export const AIRLOCK_NON_ASK_TOOLS = [
  AIRLOCK_ASK_USER_TOOL,
  AIRLOCK_NOTIFY_USER_TOOL,
  AIRLOCK_LOG_TOOL,
] as const;

export function isAirlockNonAskTool(toolName: string): boolean {
  return (AIRLOCK_NON_ASK_TOOLS as readonly string[]).includes(toolName);
}
