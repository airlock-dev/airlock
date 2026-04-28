import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { BackendAdapter } from './types.js';
import type { ToolCall, ToolResult } from '../types.js';
import type { ClientPool } from '../pool/pool.js';
import type { McpServerConfig } from '../config/schema.js';
import { wrapCommandWithSandbox, type ResolvedSandboxConfig } from '../sandbox/index.js';
import { childLogger } from '../util/logger.js';
import { VERSION } from '../version.js';

const log = childLogger('mcp-adapter');

export class McpBackendAdapter implements BackendAdapter {
  readonly id: string;

  constructor(
    private mcpId: string,
    private pool: ClientPool,
    private serverConfig?: McpServerConfig
  ) {
    this.id = `mcp:${mcpId}`;
  }

  async listTools(): Promise<Tool[]> {
    if (!this.pool.isReady(this.mcpId)) return [];
    const tools = await this.pool.listTools(this.mcpId);
    return tools.map((t) => ({
      ...t,
      name: `${this.mcpId}/${t.name}`,
    }));
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

    // If sandbox config is present and server is stdio, spawn an ephemeral sandboxed instance
    if (sandbox && this.serverConfig?.type === 'stdio') {
      return this.callSandboxed(originalName, toolCall.args, sandbox);
    }

    try {
      const data = await this.pool.callTool(this.mcpId, originalName, toolCall.args);
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
    sandbox: ResolvedSandboxConfig
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

      client = new Client({ name: 'airlock', version: VERSION });
      await client.connect(transport);

      log.info({ mcpId: this.mcpId, toolName }, 'Ephemeral sandboxed MCP connected');

      const data = await client.callTool({ name: toolName, arguments: args });
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
