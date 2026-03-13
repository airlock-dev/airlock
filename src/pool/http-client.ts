import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { FileOAuthProvider } from './oauth-provider.js';
import { childLogger } from '../util/logger.js';

const log = childLogger('http-client');

const BACKOFF_STEPS = [1000, 2000, 4000, 8000, 16000, 30000];

export class HttpMcpClient {
  private client?: Client;
  private transport?: StreamableHTTPClientTransport;
  private oauthProvider?: FileOAuthProvider;
  private reconnectAttempt = 0;
  private stopped = false;
  private ready = false;

  private awaitingAuth = false;

  constructor(
    private id: string,
    private url: string,
    private headers?: Record<string, string>,
    private oauth = false,
    private oauthCallbackPort = 18432
  ) {
    if (this.oauth) {
      this.oauthProvider = new FileOAuthProvider(this.id, this.oauthCallbackPort);
    }
  }

  async connect(): Promise<void> {
    // Don't reconnect while waiting for the user to complete the browser OAuth flow
    if (this.awaitingAuth) {
      log.debug({ id: this.id }, 'Skipping connect — already awaiting OAuth');
      return;
    }

    const transportOpts: ConstructorParameters<typeof StreamableHTTPClientTransport>[1] = {};

    if (this.headers) {
      transportOpts.requestInit = { headers: this.headers };
    }

    if (this.oauthProvider) {
      transportOpts.authProvider = this.oauthProvider;
    }

    this.transport = new StreamableHTTPClientTransport(new URL(this.url), transportOpts);

    this.client = new Client({ name: 'airlock', version: '0.1.0' });

    this.transport.onclose = () => {
      this.ready = false;
      if (!this.stopped && !this.awaitingAuth) {
        const delay = BACKOFF_STEPS[Math.min(this.reconnectAttempt, BACKOFF_STEPS.length - 1)];
        log.warn(
          { id: this.id, attempt: this.reconnectAttempt, delay },
          'HTTP MCP disconnected, reconnecting'
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
      log.info({ id: this.id, url: this.url }, 'MCP HTTP client connected');
    } catch (err) {
      if (err instanceof UnauthorizedError && this.oauthProvider) {
        this.awaitingAuth = true;
        try {
          log.info({ id: this.id }, 'OAuth authorization required, waiting for browser flow');
          const code = await this.oauthProvider.waitForAuthCode();
          await this.transport.finishAuth(code);

          this.client = new Client({ name: 'airlock', version: '0.1.0' });
          await this.client.connect(this.transport);
          this.reconnectAttempt = 0;
          this.ready = true;
          log.info({ id: this.id, url: this.url }, 'MCP HTTP client connected (after OAuth)');
        } finally {
          this.awaitingAuth = false;
        }
        return;
      }
      log.error({ err, id: this.id }, 'MCP HTTP connect failed');
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

  isReady(): boolean {
    return this.ready;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.oauthProvider?.stopCallbackServer();
    await this.transport?.close();
  }
}
