import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Client } from '@modelcontextprotocol/client';
import type { ReadResourceResult, Tool } from '@modelcontextprotocol/client';
import { ProtocolError } from '@modelcontextprotocol/server';
import type { ValidateFunction } from 'ajv';
import type { BackendAdapter } from './types.js';
import type { ToolCall, ToolResult } from '../types.js';
import type { ClientPool } from '../pool/pool.js';
import type { McpServerConfig } from '../config/schema.js';
import { wrapCommandWithSandbox, type ResolvedSandboxConfig } from '../sandbox/index.js';
import { childLogger } from '../util/logger.js';
import { isRecord } from '../util/is-record.js';
import { VERSION } from '../version.js';
import {
  namespaceToolUiMeta,
  stripToolUiMeta,
  upstreamClientCapabilities,
} from '../mcp-apps/ui.js';
import {
  assertUploadPlanActive,
  materializeUploadArgs,
  type UploadExecutionPlan,
} from '../uploads/resolve.js';
import type { UploadStore } from '../uploads/store.js';

const log = childLogger('mcp-adapter');

const DOWNSTREAM_SESSION_ID_META_KEY = 'downstreamSessionId';
const MCP_REQUEST_META_KEY = 'mcpRequestMeta';

type McpRequestMeta = Record<string, unknown>;

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function mcpRequestMeta(meta: Record<string, unknown> | undefined): McpRequestMeta | undefined {
  const downstreamSessionId = meta?.[DOWNSTREAM_SESSION_ID_META_KEY];
  if (!nonEmptyString(downstreamSessionId)) return undefined;

  const existing = meta?.[MCP_REQUEST_META_KEY];
  return {
    ...(isRecord(existing) ? existing : {}),
    agentId: downstreamSessionId,
  };
}

export class McpBackendAdapter implements BackendAdapter {
  readonly id: string;

  constructor(
    private mcpId: string,
    private pool: ClientPool,
    private serverConfig?: McpServerConfig,
    private uploadStore?: UploadStore
  ) {
    this.id = `mcp:${mcpId}`;
  }

  async listTools(): Promise<Tool[]> {
    if (!this.pool.isReady(this.mcpId)) return [];
    const tools = await this.pool.listTools(this.mcpId);
    return tools.map((t) => {
      const tool = { ...t, name: `${this.mcpId}/${t.name}` };
      // A provider that did not opt into MCP Apps never declared support, but a server may attach
      // UI metadata regardless; drop it so no view of an untrusted provider is ever offered.
      return this.mcpApps ? namespaceToolUiMeta(tool, this.mcpId) : stripToolUiMeta(tool);
    });
  }

  /** Whether this provider opted into MCP Apps passthrough (`mcp_apps: true`). */
  get mcpApps(): boolean {
    return this.serverConfig?.mcp_apps === true;
  }

  async readResource(uri: string): Promise<ReadResourceResult> {
    if (!this.mcpApps) throw new Error(`Provider ${this.mcpId} does not serve MCP Apps views`);
    return this.pool.readResource(this.mcpId, uri);
  }

  instructions(): string | undefined {
    if (!this.pool.isReady(this.mcpId)) return undefined;
    return this.pool.getInstructions(this.mcpId);
  }

  async call(toolCall: ToolCall): Promise<ToolResult> {
    const prefix = `${this.mcpId}/`;
    if (!toolCall.tool.startsWith(prefix)) {
      return {
        success: false,
        error: `Tool "${toolCall.tool}" does not belong to adapter "${this.id}"`,
      };
    }
    const originalName = toolCall.tool.slice(prefix.length);
    const sandbox = toolCall.meta?.sandbox as ResolvedSandboxConfig | undefined;
    const requestMeta = mcpRequestMeta(toolCall.meta);
    const uploadPlan = toolCall.meta?.uploadPlan as UploadExecutionPlan | undefined;

    const sessionId =
      typeof toolCall.meta?.downstreamSessionId === 'string'
        ? toolCall.meta.downstreamSessionId
        : undefined;

    let effectiveArgs = toolCall.args;
    if (uploadPlan && this.uploadStore) {
      try {
        effectiveArgs = await materializeUploadArgs(
          toolCall.args,
          toolCall.agentId,
          uploadPlan,
          this.uploadStore,
          sessionId,
          { schemaValidator: toolCall.meta?.schemaValidator as ValidateFunction | undefined }
        );
      } catch (err) {
        if (err instanceof ProtocolError) throw err;
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    const store = this.uploadStore;
    const beforeDispatch =
      uploadPlan && store
        ? () => assertUploadPlanActive(uploadPlan, toolCall.agentId, store, sessionId)
        : undefined;

    // If sandbox config is present and server is stdio, spawn an ephemeral sandboxed instance
    if (sandbox && this.serverConfig?.type === 'stdio') {
      return this.callSandboxed(originalName, effectiveArgs, sandbox, requestMeta, beforeDispatch);
    }

    try {
      beforeDispatch?.();
      const data = beforeDispatch
        ? await this.pool.callTool(
            this.mcpId,
            originalName,
            effectiveArgs,
            requestMeta,
            beforeDispatch
          )
        : requestMeta
          ? await this.pool.callTool(this.mcpId, originalName, effectiveArgs, requestMeta)
          : await this.pool.callTool(this.mcpId, originalName, effectiveArgs);
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Spawn an ephemeral sandboxed MCP server, call the tool, then tear down.
   */
  private async callSandboxed(
    toolName: string,
    args: Record<string, unknown>,
    sandbox: ResolvedSandboxConfig,
    requestMeta?: McpRequestMeta,
    beforeDispatch?: () => void
  ): Promise<ToolResult> {
    if (!this.serverConfig || this.serverConfig.type !== 'stdio') {
      return { success: false, error: 'Sandboxed call requires stdio MCP server config' };
    }

    let transport: StdioClientTransport | undefined;
    let client: Client | undefined;

    try {
      // Build the full command and wrap with sandbox
      const fullArgs = this.serverConfig.args ?? [];
      const baseCommand = [this.serverConfig.command, ...fullArgs].join(' ');
      const wrappedCommand = await wrapCommandWithSandbox(baseCommand, sandbox);

      // Parse the wrapped command back into command + args for StdioClientTransport
      // The wrapped command is a shell command, so we use sh -c to execute it
      transport = new StdioClientTransport({
        command: '/bin/sh',
        args: ['-c', wrappedCommand],
        env: this.serverConfig.env,
        stderr: 'pipe',
      });

      client = new Client(
        { name: 'airlock', version: VERSION },
        { capabilities: upstreamClientCapabilities(this.mcpApps) }
      );
      await client.connect(transport);

      log.info({ mcpId: this.mcpId, toolName }, 'Ephemeral sandboxed MCP connected');

      if (beforeDispatch) {
        beforeDispatch();
        const rawSend = transport.send.bind(transport);
        transport.send = (message) => {
          const isToolCall = Array.isArray(message)
            ? message.some(
                (item) =>
                  typeof item === 'object' &&
                  item !== null &&
                  (item as { method?: unknown }).method === 'tools/call'
              )
            : typeof message === 'object' &&
              message !== null &&
              (message as { method?: unknown }).method === 'tools/call';
          if (isToolCall) {
            try {
              beforeDispatch();
            } catch (err) {
              return Promise.reject(err instanceof Error ? err : new Error(String(err)));
            }
          }
          return rawSend(message);
        };
      }
      const request = requestMeta
        ? { name: toolName, arguments: args, _meta: requestMeta }
        : { name: toolName, arguments: args };
      const data = await client.callTool(request);
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      await transport?.close().catch(() => {});
    }
  }

  async stop(): Promise<void> {
    // Pool lifecycle is managed externally
  }
}
