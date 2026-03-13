import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { BackendAdapter } from './types.js';
import type { ToolCall, ToolResult } from '../types.js';
import { buildExecTool, executeExec } from '../tools/exec.js';
import type { AgentConfig } from '../config/schema.js';

export class ExecBackendAdapter implements BackendAdapter {
  readonly id = 'builtin:exec';

  constructor(private agents: Record<string, AgentConfig>) {}

  async listTools(): Promise<Tool[]> {
    return [buildExecTool()];
  }

  async call(toolCall: ToolCall): Promise<ToolResult> {
    if (toolCall.tool !== 'exec/run') {
      return { success: false, error: `Unknown exec tool: ${toolCall.tool}` };
    }

    const agent = this.agents[toolCall.agentId];
    if (!agent) {
      return { success: false, error: `Unknown agent: ${toolCall.agentId}` };
    }

    const command = toolCall.args['command'] as string;
    const cwd = toolCall.args['cwd'] as string | undefined;
    const timeoutMs = toolCall.args['timeout_ms'] as number | undefined;

    try {
      const data = await executeExec(command, agent, cwd, timeoutMs);
      return {
        success: true,
        data,
        metadata: { duration_ms: data.duration_ms },
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async stop(): Promise<void> {}
}
