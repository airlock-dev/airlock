import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { childLogger } from '../util/logger.js';

const log = childLogger('stdio-client');

const BACKOFF_STEPS = [1000, 2000, 4000, 8000, 16000, 30000];

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

    this.client = new Client({ name: 'airlock', version: '0.1.0' });

    this.transport.onclose = () => {
      this.ready = false;
      if (!this.stopped) {
        const delay = BACKOFF_STEPS[Math.min(this.reconnectAttempt, BACKOFF_STEPS.length - 1)];
        log.warn(
          { id: this.id, attempt: this.reconnectAttempt, delay },
          'MCP disconnected, reconnecting'
        );
        this.reconnectAttempt++;
        setTimeout(() => {
          void this.connect().catch((err) => log.error({ err, id: this.id }, 'Reconnect failed'));
        }, delay);
      }
    };

    try {
      await this.client.connect(this.transport);
      this.reconnectAttempt = 0;
      this.ready = true;
      log.info({ id: this.id }, 'MCP stdio client connected');
    } catch (err) {
      log.error({ err, id: this.id }, 'MCP stdio connect failed');
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

  async stop(): Promise<void> {
    this.stopped = true;
    await this.transport?.close();
  }
}
