import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { childLogger } from '../util/logger.js';
import { VERSION } from '../version.js';

const log = childLogger('stdio-client');

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

  constructor(
    private id: string,
    private command: string,
    private args: string[],
    private env?: Record<string, string>,
    private stderr?: 'inherit' | 'ignore' | 'pipe'
  ) {}

  async connect(): Promise<void> {
    this.transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      env: this.env,
      stderr: this.stderr,
    });

    this.client = new Client({ name: 'airlock', version: VERSION });

    this.transport.onclose = () => {
      this.ready = false;
      if (!this.stopped) {
        if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
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
        setTimeout(() => {
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
      log.info({ id: this.id }, 'MCP stdio client connected');
    } catch (err) {
      log.error({ id: this.id, reason: friendlyError(err) }, 'MCP stdio connect failed');
      throw err;
    }
  }

  async listTools(): Promise<Tool[]> {
    if (!this.client || !this.ready) throw new Error(`MCP ${this.id} not connected`);
    const result = await this.client.listTools();
    return result.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client || !this.ready) throw new Error(`MCP ${this.id} not connected`);
    return this.client.callTool({ name, arguments: args });
  }

  getServerInfo(): { name: string; version: string } | undefined {
    return this.client?.getServerVersion();
  }

  isReady(): boolean {
    return this.ready;
  }

  /** Prevent reconnection without closing the transport. */
  disableReconnect(): void {
    this.stopped = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
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
