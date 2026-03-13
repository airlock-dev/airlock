import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolCall, ToolResult } from '../types.js';

export interface BackendAdapter {
  readonly id: string;
  listTools(): Promise<Tool[]>;
  call(toolCall: ToolCall): Promise<ToolResult>;
  stop(): Promise<void>;
}
