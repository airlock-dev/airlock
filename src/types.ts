export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  agentId: string;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  metadata?: { duration_ms?: number; truncated?: boolean };
}
