export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  agentId: string;
  meta?: Record<string, unknown>;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  metadata?: { duration_ms?: number; truncated?: boolean };
}
