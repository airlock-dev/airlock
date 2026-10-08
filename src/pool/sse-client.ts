import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { McpCallOptions } from '../types.js';
import type { ProviderConnectionStatus } from './status.js';
import { childLogger } from '../util/logger.js';
import { VERSION } from '../version.js';

const log = childLogger('sse-client');

type McpRequestMeta = Record<string, unknown>;

const BACKOFF_STEPS = [1000, 2000, 4000, 8000, 16000, 30000];

function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('ENOTFOUND')) {
    const host = msg.match(/ENOTFOUND\s+(\S+)/)?.[1];
    return `DNS lookup failed for ${host ?? 'unknown host'}`;
  }
  if (msg.includes('ECONNREFUSED')) return 'connection refused';
  return msg.split('\n')[0];
}

export class SseMcpClient {
  private client?: Client;
  private transport?: SSEClientTransport;
  private reconnectAttempt = 0;
  private stopped = false;
  private ready = false;
  private connecting = false;
  private reconnectTimer?: NodeJS.Timeout;
  private lastError?: string;
  private readyListeners = new Set<() => void>();
  private toolsChangedListeners = new Set<() => void>();

  constructor(
    private id: string,
    private url: string,
    private headers?: Record<string, string>
  ) {}

  onReady(cb: () => void): void {
    this.readyListeners.add(cb);
  }

  onToolsChanged(cb: () => void): void {
    this.toolsChangedListeners.add(cb);
  }

  async connect(): Promise<void> {
    this.transport = new SSEClientTransport(new URL(this.url), {
      requestInit: this.headers ? { headers: this.headers } : undefined,
    });

    this.client = new Client(
      { name: 'airlock', version: VERSION },
      {
        listChanged: {
          tools: {
            autoRefresh: false,
            debounceMs: 0,
            onChanged: (error) => {
              if (error) {
                log.warn({ id: this.id, err: error }, 'MCP tools/list_changed refresh failed');
                return;
              }
              this.notifyToolsChanged();
            },
          },
        },
      }
    );
    this.connecting = true;

    this.transport.onclose = () => {
      this.ready = false;
      this.connecting = false;
      this.lastError ??= 'connection closed';
      if (!this.stopped) {
        const delay = BACKOFF_STEPS[Math.min(this.reconnectAttempt, BACKOFF_STEPS.length - 1)];
        log.warn(
          { id: this.id, attempt: this.reconnectAttempt, delay },
          'SSE MCP disconnected, reconnecting'
        );
        this.reconnectAttempt++;
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = undefined;
          void this.connect().catch((err) =>
            log.error({ id: this.id, reason: friendlyError(err) }, 'Reconnect failed')
          );
        }, delay);
      }
    };

    try {
      await this.client.connect(this.transport);
      this.reconnectAttempt = 0;
      this.ready = true;
      this.connecting = false;
      this.lastError = undefined;
      log.info({ id: this.id, url: this.url }, 'MCP SSE client connected');
      this.notifyReady();
    } catch (err) {
      this.ready = false;
      this.connecting = false;
      this.lastError = friendlyError(err);
      log.error({ id: this.id, reason: friendlyError(err) }, 'MCP SSE connect failed');
      throw err;
    }
  }

  async listTools(): Promise<Tool[]> {
    if (!this.client || !this.ready) throw new Error(`MCP ${this.id} not connected`);
    // The SDK caches output-schema validators per response page (the final page
    // wins). Airlock keeps the aggregate definitions here and does not use that
    // private cache for task filtering; tool fields remain intact across pages.
    const tools: Tool[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;

    while (true) {
      const result = await this.client.listTools(cursor === undefined ? undefined : { cursor });
      tools.push(...result.tools);

      const nextCursor = result.nextCursor;
      if (nextCursor === undefined) return tools;
      if (cursors.has(nextCursor)) {
        throw new Error(`MCP ${this.id} returned a repeated tools/list cursor`);
      }
      cursors.add(nextCursor);
      cursor = nextCursor;
    }
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    requestMeta?: McpRequestMeta,
    options?: McpCallOptions
  ): Promise<unknown> {
    if (!this.client || !this.ready) throw new Error(`MCP ${this.id} not connected`);
    const request = requestMeta
      ? { name, arguments: args, _meta: requestMeta }
      : { name, arguments: args };
    return options
      ? this.client.callTool(request, undefined, options)
      : this.client.callTool(request);
  }

  getServerInfo(): { name: string; version: string } | undefined {
    return this.client?.getServerVersion();
  }

  /** Server-level usage notes advertised at initialize (MCP `instructions`). */
  getInstructions(): string | undefined {
    return this.client?.getInstructions();
  }

  isReady(): boolean {
    return this.ready;
  }

  getConnectionStatus(): ProviderConnectionStatus {
    if (this.ready) return { status: 'up' };
    if (this.connecting || this.reconnectTimer || (!this.stopped && this.reconnectAttempt > 0)) {
      return { status: 'connecting', ...(this.lastError ? { reason: this.lastError } : {}) };
    }
    return { status: 'down', ...(this.lastError ? { reason: this.lastError } : {}) };
  }

  private notifyReady(): void {
    for (const cb of this.readyListeners) {
      cb();
    }
  }

  private notifyToolsChanged(): void {
    for (const cb of this.toolsChangedListeners) {
      cb();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    await this.transport?.close();
  }
}
