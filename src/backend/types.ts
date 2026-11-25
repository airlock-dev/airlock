import type { ReadResourceResult, Tool } from '@modelcontextprotocol/server';
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
  /**
   * Read a resource by its upstream URI. Only real MCP servers have resources; Airlock uses this to
   * serve MCP Apps views (`ui://`) for the tools it proxies.
   */
  readResource?(uri: string): Promise<ReadResourceResult>;
  /**
   * Report whether a tool argument natively consumes a staged upload as raw binary or multipart
   * form data (used by OpenAPI and built-in HTTP adapters). Returning undefined means the backend
   * uses string substitution (`base64`, `data_uri`, `text`, `path`, `url`) instead.
   */
  nativeUploadArgKind?(toolName: string, topKey: string): 'binary' | 'multipart' | undefined;
}
