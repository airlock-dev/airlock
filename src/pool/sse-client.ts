import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
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

  constructor(
    private id: string,
    private url: string,
    private headers?: Record<string, string>
  ) {}

  onReady(cb: () => void): void {
    this.readyListeners.add(cb);
  }

  async connect(): Promise<void> {
    this.transport = new SSEClientTransport(new URL(this.url), {
      requestInit: this.headers ? { headers: this.headers } : undefined,
    });

    this.client = new Client({ name: 'airlock', version: VERSION });
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
    const result = await this.client.listTools();
    return result.tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    requestMeta?: McpRequestMeta
  ): Promise<unknown> {
    if (!this.client || !this.ready) throw new Error(`MCP ${this.id} not connected`);
    const request = requestMeta
      ? { name, arguments: args, _meta: requestMeta }
      : { name, arguments: args };
    return this.client.callTool(request);
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

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    await this.transport?.close();
  }
}
