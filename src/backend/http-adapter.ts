import type { Tool } from '@modelcontextprotocol/server';
import type { BackendAdapter } from './types.js';
import type { ToolCall, ToolResult } from '../types.js';
import type { AgentConfig, SecurityConfig } from '../config/schema.js';
import { buildHttpTools, executeHttp, HTTP_METHODS, type HttpMethod } from '../tools/http.js';
import type { UploadExecutionPlan } from '../uploads/resolve.js';
import type { UploadStore } from '../uploads/store.js';

const VALID_METHODS = new Set<string>(HTTP_METHODS);
const UPLOAD_BODY_TOOLS = new Set(['http/post', 'http/put', 'http/patch']);

export class HttpBackendAdapter implements BackendAdapter {
  readonly id = 'builtin:http';

  constructor(
    private agents: Record<string, AgentConfig>,
    private security: SecurityConfig,
    private uploadStore?: UploadStore,
    private uploadsEnabled?: boolean
  ) {}

  listTools(): Promise<Tool[]> {
    return Promise.resolve(
      buildHttpTools({
        uploadsEnabled: Boolean(this.uploadStore?.isEnabled() ?? this.uploadsEnabled),
      })
    );
  }

  nativeUploadArgKind(toolName: string, topKey: string): 'binary' | 'multipart' | undefined {
    if (!UPLOAD_BODY_TOOLS.has(toolName)) return undefined;
    if (topKey === 'body_upload') return 'binary';
    if (topKey === 'multipart') return 'multipart';
    return undefined;
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
    const sessionId =
      typeof toolCall.meta?.downstreamSessionId === 'string'
        ? toolCall.meta.downstreamSessionId
        : undefined;
    const uploadPlan = toolCall.meta?.uploadPlan as UploadExecutionPlan | undefined;
    try {
      const data = await executeHttp(
        method as HttpMethod,
        toolCall.args,
        agent,
        this.security,
        this.uploadStore,
        toolCall.agentId,
        sessionId,
        uploadPlan
      );
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async stop(): Promise<void> {}
}
