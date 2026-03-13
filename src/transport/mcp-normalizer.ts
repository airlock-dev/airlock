import type { ToolCall, ToolResult } from '../types.js';

export function callToolRequestToToolCall(
  name: string,
  args: Record<string, unknown>,
  agentId: string,
): ToolCall {
  return { tool: name, args, agentId };
}

export function toolResultToCallToolResult(result: ToolResult): {
  content: Array<{ type: 'text'; text: string }>;
} {
  if (!result.success) {
    throw new Error(result.error ?? 'Unknown error');
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(result.data) }],
  };
}
