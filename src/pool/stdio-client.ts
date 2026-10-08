import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { McpCallOptions } from '../types.js';
import type { ProviderConnectionStatus } from './status.js';
import { childLogger } from '../util/logger.js';
import { VERSION } from '../version.js';

const log = childLogger('stdio-client');

type McpRequestMeta = Record<string, unknown>;

const BACKOFF_STEPS = [1000, 2000, 4000, 8000, 16000, 30000];
const MAX_RECONNECT_ATTEMPTS = BACKOFF_STEPS.length;

/** Extract a short, human-readable reason from a connection error. */
function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('Connection closed')) return 'process exited immediately';
  if (msg.includes('ENOENT'))
    return `command not found: ${msg.match(/ENOENT.*?'(.+?)'/)?.[1] ?? 'unknown'}`;
  return msg.split('\n')[0];
}

export class StdioMcpClient {
  private client?: Client;
  private transport?: StdioClientTransport;
  private reconnectAttempt = 0;
  private stopped = false;
  private ready = false;
  private connecting = false;
  private reconnectExhausted = false;
  private reconnectTimer?: NodeJS.Timeout;
  private lastError?: string;
  private readyListeners = new Set<() => void>();
  private toolsChangedListeners = new Set<() => void>();

  constructor(
    private id: string,
    private command: string,
    private args: string[],
    private env?: Record<string, string>,
    private stderr?: 'inherit' | 'ignore' | 'pipe'
  ) {}

  onReady(cb: () => void): void {
    this.readyListeners.add(cb);
  }

  onToolsChanged(cb: () => void): void {
    this.toolsChangedListeners.add(cb);
  }

  async connect(): Promise<void> {
    this.transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      env: this.env,
      stderr: this.stderr,
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
    this.reconnectExhausted = false;

    this.transport.onclose = () => {
      this.ready = false;
      this.connecting = false;
      this.lastError ??= 'process exited';
      if (!this.stopped) {
        if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
          this.reconnectExhausted = true;
          log.error(
            { id: this.id },
            'MCP gave up reconnecting after %d attempts',
            MAX_RECONNECT_ATTEMPTS
          );
          return;
        }
        const delay = BACKOFF_STEPS[Math.min(this.reconnectAttempt, BACKOFF_STEPS.length - 1)];
        log.warn(
          { id: this.id, attempt: this.reconnectAttempt, delay },
          'MCP disconnected, reconnecting'
        );
        this.reconnectAttempt++;
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = undefined;
          void this.connect().catch((err) =>
            log.error({ id: this.id, reason: friendlyError(err) }, 'MCP reconnect failed')
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
      log.info({ id: this.id }, 'MCP stdio client connected');
      this.notifyReady();
    } catch (err) {
      this.ready = false;
      this.connecting = false;
      this.lastError = friendlyError(err);
      log.error({ id: this.id, reason: friendlyError(err) }, 'MCP stdio connect failed');
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
    if (
      this.connecting ||
      this.reconnectTimer ||
      (!this.stopped && !this.reconnectExhausted && this.reconnectAttempt > 0)
    ) {
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

  /** Prevent reconnection without closing the transport. */
  disableReconnect(): void {
    this.stopped = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    await this.transport?.close();
  }

  /** Send SIGKILL to the child process if it's still alive. */
  kill(): void {
    const pid = this.transport?.pid;
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already dead */
      }
    }
  }
}
