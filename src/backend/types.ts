import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolCall, ToolResult } from '../types.js';

export interface BackendAdapter {
  readonly id: string;
  listTools(): Promise<Tool[]>;
  call(toolCall: ToolCall): Promise<ToolResult>;
  stop(): Promise<void>;
  /**
   * Server-level usage notes this backend advertises (MCP `instructions`).
   *
   * Optional: only real MCP servers have a notion of this. Synthetic adapters (exec, http, openapi,
   * cli, the airlock builtin) simply omit it, and operators can still attach notes to them through
   * the provider's `instructions` config key.
   */
  instructions?(): string | undefined;
}
