import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { BackendAdapter } from './types.js';
import type { ToolCall, ToolResult } from '../types.js';
import type { AgentConfig, SecurityConfig } from '../config/schema.js';
import { buildHttpTools, executeHttp } from '../tools/http.js';

export class HttpBackendAdapter implements BackendAdapter {
  readonly id = 'builtin:http';
  private tools: Tool[];

  constructor(
    private agents: Record<string, AgentConfig>,
    private security: SecurityConfig,
  ) {
    this.tools = buildHttpTools();
  }

  async listTools(): Promise<Tool[]> {
    return this.tools;
  }

  async call(toolCall: ToolCall): Promise<ToolResult> {
    const match = toolCall.tool.match(/^http\/(get|post|put|patch|delete|head)$/);
    if (!match) {
      return { success: false, error: `Unknown HTTP tool: ${toolCall.tool}` };
    }

    const agent = this.agents[toolCall.agentId];
    if (!agent) {
      return { success: false, error: `Unknown agent: ${toolCall.agentId}` };
    }

    const method = match[1] as 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head';
    try {
      const data = await executeHttp(method, toolCall.args, agent, this.security);
      return {
        success: true,
        data,
        metadata: { truncated: data.truncated },
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async stop(): Promise<void> {}
}
