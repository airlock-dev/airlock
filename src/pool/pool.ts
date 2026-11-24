import { StdioMcpClient } from './stdio-client.js';
import { SseMcpClient } from './sse-client.js';
import { HttpMcpClient } from './http-client.js';
import type { ProviderConnectionStatus } from './status.js';
import type { McpServerConfig } from '../config/schema.js';
import { resolveProviderBearerFile } from '../config/provider-credentials.js';
import type { Tool } from '@modelcontextprotocol/server';
import type {
  EventDescriptor,
  EventsPollParams,
  EventsPollResult,
  EventsStreamParams,
} from '../events/protocol.js';
import type {
  UpstreamEventStreamCallbacks,
  UpstreamEventStreamHandle,
  UpstreamEventStreamOptions,
} from '../events/upstream-client.js';
import { childLogger } from '../util/logger.js';

const log = childLogger('pool');

/** Provider fields the gateway reads elsewhere; the MCP client itself never uses them. */
const NON_CONNECTION_FIELDS = new Set([
  'instructions',
  'upstream_instructions',
  'credential_probe',
]);

/** A stable fingerprint of the settings a client is built from (key order does not matter). */
function connectionKey(cfg: McpServerConfig | undefined): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical((value as Record<string, unknown>)[key])])
      );
    }
    return value;
  };
  if (!cfg) return '';
  const connection = Object.fromEntries(
    Object.entries(cfg).filter(([key]) => !NON_CONNECTION_FIELDS.has(key))
  );
  return JSON.stringify(canonical(connection));
}

type McpClient = StdioMcpClient | SseMcpClient | HttpMcpClient;
type McpRequestMeta = Record<string, unknown>;
export type HealthStatus = 'ok' | 'degraded' | 'down';

interface ClientPoolOptions {
  stdioStderr?: 'inherit' | 'ignore' | 'pipe';
  healthCheck?: boolean;
  retryFailedConnections?: boolean;
  /** Provider IDs that should probe MCP 2026-07-28 (`server/discover`) even over stdio. */
  eventsProviders?: Set<string>;
}

export class ClientPool {
  private clients = new Map<string, McpClient>();
  private healthTimer?: NodeJS.Timeout;
  private _onClientReady?: (id: string) => void;
  private _onEventsListChanged?: (id: string) => void;
  private eventsProviders: Set<string>;

  constructor(
    private mcps: Record<string, McpServerConfig>,
    private options?: ClientPoolOptions
  ) {
    this.eventsProviders = new Set(options?.eventsProviders ?? []);
  }

  onClientReady(cb: (id: string) => void): void {
    this._onClientReady = cb;
  }

  onEventsListChanged(cb: (id: string) => void): void {
    this._onEventsListChanged = cb;
  }

  async initialize(): Promise<void> {
    const entries = Object.entries(this.mcps);
    await Promise.allSettled(entries.map(([id, cfg]) => this.connectClient(id, cfg)));
    this.startHealthCheck();
  }

  private async connectClient(id: string, cfg: McpServerConfig): Promise<void> {
    let connection: McpServerConfig;
    try {
      // CLI and dashboard discovery can construct a pool from a structurally parsed config.
      connection = resolveProviderBearerFile(cfg);
    } catch (error) {
      log.warn({ id }, error instanceof Error ? error.message : 'Invalid provider credential');
      return;
    }
    const client = this.createClient(id, connection);
    this.clients.set(id, client);
    client.onReady(() => this.notifyClientReady(id));
    if (client instanceof HttpMcpClient || client instanceof StdioMcpClient) {
      client.onEventsListChanged(() => this._onEventsListChanged?.(id));
    }
    try {
      await client.connect();
      if (!client.isReady()) {
        log.info({ id }, 'MCP connection pending');
      }
    } catch {
      if (this.options?.retryFailedConnections === false) {
        log.warn({ id }, 'Failed to connect MCP');
      } else {
        log.warn({ id }, 'Failed to connect MCP (will retry in background)');
        this.connectInBackground(id, client);
      }
    }
  }

  private connectInBackground(id: string, client: McpClient): void {
    client.connect().catch(() => {});
  }

  private notifyClientReady(id: string): void {
    log.info({ id }, 'MCP connected');
    this._onClientReady?.(id);
  }

  private createClient(id: string, cfg: McpServerConfig): McpClient {
    switch (cfg.type) {
      case 'stdio':
        return new StdioMcpClient(
          id,
          cfg.command,
          cfg.args,
          cfg.env,
          this.options?.stdioStderr,
          this.eventsProviders.has(id)
        );
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
          cfg.oauth_callback_url,
          cfg.client_credentials,
          cfg.request_timeout_ms
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

  getProviderConnectionStatus(mcpId: string): ProviderConnectionStatus | undefined {
    return this.clients.get(mcpId)?.getConnectionStatus();
  }

  /** Whether Airlock owns an authorization-code OAuth credential for this provider. */
  isOAuthProvider(mcpId: string): boolean {
    const cfg = this.mcps[mcpId];
    return cfg?.type === 'http' && cfg.oauth === true;
  }

  async callTool(
    mcpId: string,
    toolName: string,
    args: Record<string, unknown>,
    requestMeta?: McpRequestMeta
  ): Promise<unknown> {
    const client = this.clients.get(mcpId);
    if (!client) throw new Error(`Unknown MCP: ${mcpId}`);
    if (!client.isReady()) throw new Error(`MCP ${mcpId} is not connected`);
    return client.callTool(toolName, args, requestMeta);
  }

  supportsEvents(mcpId: string): boolean {
    return this.clients.get(mcpId)?.supportsEvents() ?? false;
  }

  async listEvents(mcpId: string): Promise<EventDescriptor[]> {
    const client = this.clients.get(mcpId);
    if (!client) throw new Error(`Unknown MCP: ${mcpId}`);
    if (!client.isReady()) throw new Error(`MCP ${mcpId} is not connected`);
    return client.listEvents();
  }

  async pollEvents(
    mcpId: string,
    params: EventsPollParams,
    options?: { inputSchema?: Record<string, unknown>; signal?: AbortSignal }
  ): Promise<EventsPollResult> {
    const client = this.clients.get(mcpId);
    if (!client) throw new Error(`Unknown MCP: ${mcpId}`);
    if (!client.isReady()) throw new Error(`MCP ${mcpId} is not connected`);
    return client.pollEvents(params, options);
  }

  async openEventStream(
    mcpId: string,
    params: EventsStreamParams,
    callbacks: UpstreamEventStreamCallbacks,
    options?: UpstreamEventStreamOptions
  ): Promise<UpstreamEventStreamHandle> {
    const client = this.clients.get(mcpId);
    if (!client) throw new Error(`Unknown MCP: ${mcpId}`);
    if (!client.isReady()) throw new Error(`MCP ${mcpId} is not connected`);
    return client.openEventStream(params, callbacks, options);
  }

  async reload(
    newMcps: Record<string, McpServerConfig>,
    newEventsProviders?: Set<string>
  ): Promise<void> {
    const oldIds = new Set(this.clients.keys());
    const newIds = new Set(Object.keys(newMcps));
    const prevEventsProviders = this.eventsProviders;
    if (newEventsProviders) {
      this.eventsProviders = new Set(newEventsProviders);
    }

    // Remove MCPs that no longer exist
    for (const id of oldIds) {
      if (!newIds.has(id)) {
        log.info({ id }, 'Removing MCP (no longer in config)');
        const client = this.clients.get(id)!;
        await client.stop().catch((err) => log.error({ err, id }, 'Error stopping removed MCP'));
        this.clients.delete(id);
      }
    }

    // Add new MCPs, and restart existing ones whose connection settings changed (url, headers,
    // command, auth…), or stdio providers that newly gained event permissions and need 2026-07-28
    // `server/discover` negotiation.
    const restarts: Promise<void>[] = [];
    for (const [id, cfg] of Object.entries(newMcps)) {
      const stdioNeedsModernUpgrade =
        cfg.type === 'stdio' && !prevEventsProviders.has(id) && this.eventsProviders.has(id);
      if (!oldIds.has(id)) {
        log.info({ id }, 'Adding new MCP from config reload');
        void this.connectClient(id, cfg);
      } else if (connectionKey(this.mcps[id]) !== connectionKey(cfg) || stdioNeedsModernUpgrade) {
        log.info({ id }, 'Restarting MCP (connection settings changed)');
        const client = this.clients.get(id);
        restarts.push(
          (client?.stop() ?? Promise.resolve())
            .catch((err) => log.error({ err, id }, 'Error stopping changed MCP'))
            .then(() => {
              this.clients.delete(id);
              void this.connectClient(id, cfg);
            })
        );
      } else if (cfg.type === 'stdio') {
        // Keep probeModern in sync so a future reconnect stops probing once event access is removed.
        const client = this.clients.get(id);
        if (client instanceof StdioMcpClient) {
          client.setProbeModern(this.eventsProviders.has(id));
        }
      }
    }
    await Promise.all(restarts);

    this.mcps = newMcps;
  }

  healthCheck(): Record<string, HealthStatus> {
    const result: Record<string, HealthStatus> = {};
    for (const [id, client] of this.clients) {
      const status = client.getConnectionStatus().status;
      result[id] = status === 'up' ? 'ok' : status === 'down' ? 'down' : 'degraded';
    }
    return result;
  }

  getServerInfo(mcpId: string): { name: string; version: string } | undefined {
    return this.clients.get(mcpId)?.getServerInfo();
  }

  /** Server-level usage notes the provider advertised at initialize (MCP `instructions`). */
  getInstructions(mcpId: string): string | undefined {
    return this.clients.get(mcpId)?.getInstructions();
  }

  getMcpIds(): string[] {
    return Array.from(this.clients.keys());
  }

  private startHealthCheck(): void {
    if (this.options?.healthCheck === false) return;
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
