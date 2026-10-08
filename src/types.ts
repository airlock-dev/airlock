import type { ProgressCallback } from '@modelcontextprotocol/sdk/shared/protocol.js';

export interface McpCallOptions {
  signal?: AbortSignal;
  onprogress?: ProgressCallback;
}

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  agentId: string;
  meta?: Record<string, unknown>;
  options?: McpCallOptions;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  cause?: unknown;
  metadata?: { duration_ms?: number; truncated?: boolean };
}
