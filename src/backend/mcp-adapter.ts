import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { BackendAdapter } from './types.js';
import type { ToolCall, ToolResult } from '../types.js';
import type { ClientPool } from '../pool/pool.js';

export class McpBackendAdapter implements BackendAdapter {
  readonly id: string;

  constructor(
    private mcpId: string,
    private pool: ClientPool,
  ) {
    this.id = `mcp:${mcpId}`;
  }

  async listTools(): Promise<Tool[]> {
    const tools = await this.pool.listTools(this.mcpId);
    return tools.map(t => ({
      ...t,
      name: `${this.mcpId}/${t.name}`,
    }));
  }

  async call(toolCall: ToolCall): Promise<ToolResult> {
    const originalName = toolCall.tool.slice(this.mcpId.length + 1);
    try {
      const data = await this.pool.callTool(this.mcpId, originalName, toolCall.args);
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async stop(): Promise<void> {
    // Pool lifecycle is managed externally
  }
}
