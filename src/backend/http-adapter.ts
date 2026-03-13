import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { BackendAdapter } from './types.js';
import type { ToolCall, ToolResult } from '../types.js';
import type { AgentConfig, SecurityConfig } from '../config/schema.js';
import { buildHttpTools, executeHttp, HTTP_METHODS, type HttpMethod } from '../tools/http.js';

const VALID_METHODS = new Set<string>(HTTP_METHODS);

export class HttpBackendAdapter implements BackendAdapter {
  readonly id = 'builtin:http';
  private tools: Tool[];

  constructor(
    private agents: Record<string, AgentConfig>,
    private security: SecurityConfig
  ) {
    this.tools = buildHttpTools();
  }

  listTools(): Promise<Tool[]> {
    return Promise.resolve(this.tools);
  }

  async call(toolCall: ToolCall): Promise<ToolResult> {
    const method = toolCall.tool.startsWith('http/') ? toolCall.tool.slice(5) : undefined;
    if (!method || !VALID_METHODS.has(method)) {
      return { success: false, error: `Unknown HTTP tool: ${toolCall.tool}` };
    }

    const agent = this.agents[toolCall.agentId];
    if (!agent) {
      return { success: false, error: `Unknown agent: ${toolCall.agentId}` };
    }
    try {
      const data = await executeHttp(method as HttpMethod, toolCall.args, agent, this.security);
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
