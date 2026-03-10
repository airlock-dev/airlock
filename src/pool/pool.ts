import { StdioMcpClient } from './stdio-client.js';
import { SseMcpClient } from './sse-client.js';
import type { McpServerConfig } from '../config/schema.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { childLogger } from '../util/logger.js';

const log = childLogger('pool');

type McpClient = StdioMcpClient | SseMcpClient;
export type HealthStatus = 'ok' | 'degraded' | 'down';

export class ClientPool {
  private clients = new Map<string, McpClient>();
  private healthTimer?: NodeJS.Timeout;

  constructor(private mcps: Record<string, McpServerConfig>) {}

  async initialize(): Promise<void> {
    const entries = Object.entries(this.mcps);
    await Promise.allSettled(entries.map(async ([id, cfg]) => {
      try {
        const client = this.createClient(id, cfg);
        await client.connect();
        this.clients.set(id, client);
        log.info({ id }, 'MCP connected');
      } catch (err) {
        log.error({ err, id }, 'Failed to connect MCP (will retry in background)');
        // Still create the client so it can reconnect
        const client = this.createClient(id, cfg);
        this.clients.set(id, client);
        // Start reconnect loop
        client.connect().catch(() => {});
      }
    }));

    this.startHealthCheck();
  }

  private createClient(id: string, cfg: McpServerConfig): McpClient {
    if (cfg.type === 'stdio') {
      if (!cfg.command) throw new Error(`MCP ${id}: stdio type requires 'command'`);
      return new StdioMcpClient(id, cfg.command, cfg.args ?? [], cfg.env);
    } else {
      if (!cfg.url) throw new Error(`MCP ${id}: sse type requires 'url'`);
      return new SseMcpClient(id, cfg.url, cfg.headers);
    }
  }

  async listTools(mcpId: string): Promise<Tool[]> {
    const client = this.clients.get(mcpId);
    if (!client) throw new Error(`Unknown MCP: ${mcpId}`);
    return client.listTools();
  }

  async callTool(mcpId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const client = this.clients.get(mcpId);
    if (!client) throw new Error(`Unknown MCP: ${mcpId}`);
    if (!client.isReady()) throw new Error(`MCP ${mcpId} is not connected`);
    return client.callTool(toolName, args);
  }

  healthCheck(): Record<string, HealthStatus> {
    const result: Record<string, HealthStatus> = {};
    for (const [id, client] of this.clients) {
      result[id] = client.isReady() ? 'ok' : 'down';
    }
    return result;
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

  async stop(): Promise<void> {
    clearInterval(this.healthTimer);
    await Promise.allSettled(
      Array.from(this.clients.values()).map(c => c.stop()),
    );
  }
}
