import { StdioMcpClient } from './stdio-client.js';
import { SseMcpClient } from './sse-client.js';
import { HttpMcpClient } from './http-client.js';
import type { McpServerConfig } from '../config/schema.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { childLogger } from '../util/logger.js';

const log = childLogger('pool');

type McpClient = StdioMcpClient | SseMcpClient | HttpMcpClient;
export type HealthStatus = 'ok' | 'degraded' | 'down';

export class ClientPool {
  private clients = new Map<string, McpClient>();
  private healthTimer?: NodeJS.Timeout;
  private _onClientReady?: (id: string) => void;

  constructor(
    private mcps: Record<string, McpServerConfig>,
    private options?: { stdioStderr?: 'inherit' | 'ignore' | 'pipe' }
  ) {}

  onClientReady(cb: (id: string) => void): void {
    this._onClientReady = cb;
  }

  async initialize(): Promise<void> {
    const entries = Object.entries(this.mcps);
    await Promise.allSettled(entries.map(([id, cfg]) => this.connectClient(id, cfg)));
    this.startHealthCheck();
  }

  private async connectClient(id: string, cfg: McpServerConfig): Promise<void> {
    const client = this.createClient(id, cfg);
    this.clients.set(id, client);
    try {
      await client.connect();
      log.info({ id }, 'MCP connected');
      this._onClientReady?.(id);
    } catch {
      log.warn({ id }, 'Failed to connect MCP (will retry in background)');
      this.connectInBackground(id, client);
    }
  }

  private connectInBackground(id: string, client: McpClient): void {
    client
      .connect()
      .then(() => {
        log.info({ id }, 'MCP connected (background)');
        this._onClientReady?.(id);
      })
      .catch(() => {});
  }

  private createClient(id: string, cfg: McpServerConfig): McpClient {
    switch (cfg.type) {
      case 'stdio':
        return new StdioMcpClient(id, cfg.command, cfg.args, cfg.env, this.options?.stdioStderr);
      case 'sse':
        return new SseMcpClient(id, cfg.url, cfg.headers);
      case 'http':
        return new HttpMcpClient(
          id,
          cfg.url,
          cfg.headers,
          cfg.oauth,
          cfg.oauth_callback_port,
          cfg.client_id,
          cfg.client_secret,
          cfg.oauth_callback_url
        );
    }
  }

  async listTools(mcpId: string): Promise<Tool[]> {
    const client = this.clients.get(mcpId);
    if (!client) throw new Error(`Unknown MCP: ${mcpId}`);
    return client.listTools();
  }

  isReady(mcpId: string): boolean {
    return this.clients.get(mcpId)?.isReady() ?? false;
  }

  async callTool(mcpId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const client = this.clients.get(mcpId);
    if (!client) throw new Error(`Unknown MCP: ${mcpId}`);
    if (!client.isReady()) throw new Error(`MCP ${mcpId} is not connected`);
    return client.callTool(toolName, args);
  }

  async reload(newMcps: Record<string, McpServerConfig>): Promise<void> {
    const oldIds = new Set(this.clients.keys());
    const newIds = new Set(Object.keys(newMcps));

    // Remove MCPs that no longer exist
    for (const id of oldIds) {
      if (!newIds.has(id)) {
        log.info({ id }, 'Removing MCP (no longer in config)');
        const client = this.clients.get(id)!;
        await client.stop().catch((err) => log.error({ err, id }, 'Error stopping removed MCP'));
        this.clients.delete(id);
      }
    }

    // Add new MCPs
    for (const [id, cfg] of Object.entries(newMcps)) {
      if (!oldIds.has(id)) {
        log.info({ id }, 'Adding new MCP from config reload');
        void this.connectClient(id, cfg);
      }
    }

    this.mcps = newMcps;
  }

  healthCheck(): Record<string, HealthStatus> {
    const result: Record<string, HealthStatus> = {};
    for (const [id, client] of this.clients) {
      result[id] = client.isReady() ? 'ok' : 'down';
    }
    return result;
  }

  getServerInfo(mcpId: string): { name: string; version: string } | undefined {
    return this.clients.get(mcpId)?.getServerInfo();
  }

  getMcpIds(): string[] {
    return Array.from(this.clients.keys());
  }

  private startHealthCheck(): void {
    this.healthTimer = setInterval(() => {
      const health = this.healthCheck();
      const down = Object.entries(health).filter(([, s]) => s === 'down');
      if (down.length > 0) {
        log.warn({ down: down.map(([id]) => id) }, 'Some MCPs are down');
      }
    }, 30_000);
    this.healthTimer.unref();
  }

  /** Disable reconnection on all clients without closing them yet. */
  disableReconnect(): void {
    for (const client of this.clients.values()) {
      if (client instanceof StdioMcpClient) {
        client.disableReconnect();
      }
    }
  }

  async stop(): Promise<void> {
    clearInterval(this.healthTimer);
    this.disableReconnect();
    await Promise.allSettled(Array.from(this.clients.values()).map((c) => c.stop()));
  }

  /** SIGKILL any stdio child processes that survived graceful stop. */
  forceKill(): void {
    for (const client of this.clients.values()) {
      if (client instanceof StdioMcpClient) {
        client.kill();
      }
    }
  }
}
