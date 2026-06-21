import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { FileOAuthProvider } from './oauth-provider.js';
import { childLogger } from '../util/logger.js';
import { VERSION } from '../version.js';

const log = childLogger('http-client');

type McpRequestMeta = Record<string, unknown>;

const BACKOFF_STEPS = [1000, 2000, 4000, 8000, 16000, 30000];
const MAX_RECONNECT_ATTEMPTS = BACKOFF_STEPS.length;

/** Extract a short, human-readable reason from a connection error. */
function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('ENOTFOUND')) {
    const host = msg.match(/ENOTFOUND\s+(\S+)/)?.[1];
    return `DNS lookup failed for ${host ?? 'unknown host'}`;
  }
  if (msg.includes('InvalidGrantError') || err?.constructor?.name === 'InvalidGrantError') {
    return 'OAuth grant expired — re-authentication required';
  }
  if (msg.includes('ECONNREFUSED')) return 'connection refused';
  return msg.split('\n')[0];
}

function isInvalidSessionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const normalized = msg.toLowerCase();
  return (
    normalized.includes('no valid session id provided') ||
    normalized.includes('missing session id') ||
    normalized.includes('invalid or expired session id') ||
    normalized.includes('session not found')
  );
}

export class HttpMcpClient {
  private client?: Client;
  private transport?: StreamableHTTPClientTransport;
  private oauthProvider?: FileOAuthProvider;
  private reconnectAttempt = 0;
  private stopped = false;
  private ready = false;
  private reconnectTimer?: NodeJS.Timeout;
  private readyListeners = new Set<() => void>();

  private awaitingAuth = false;

  constructor(
    private id: string,
    private url: string,
    private headers?: Record<string, string>,
    private oauth = false,
    private oauthCallbackPort = 18432,
    private clientId?: string,
    private clientSecret?: string,
    private oauthCallbackUrl?: string
  ) {
    if (this.oauth) {
      this.oauthProvider = new FileOAuthProvider(
        this.id,
        this.oauthCallbackPort,
        this.clientId,
        this.clientSecret,
        this.oauthCallbackUrl
      );
    }
  }

  onReady(cb: () => void): void {
    this.readyListeners.add(cb);
  }

  async connect(): Promise<void> {
    // Don't reconnect while waiting for the user to complete the browser OAuth flow
    if (this.awaitingAuth) {
      log.debug({ id: this.id }, 'Skipping connect — already awaiting OAuth');
      return;
    }

    // Cancel any pending reconnect timer to prevent concurrent connect() calls.
    // This matters when connectInBackground() calls connect() immediately while a
    // timer from a previous onclose is still pending — without this, both would run
    // concurrently and the timer's connect() would overwrite this.client/transport
    // mid-flight, causing listTools() to use a client with no session ID yet.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    const transportOpts: ConstructorParameters<typeof StreamableHTTPClientTransport>[1] = {};

    if (this.headers) {
      transportOpts.requestInit = { headers: this.headers };
    }

    if (this.oauthProvider) {
      transportOpts.authProvider = this.oauthProvider;
    }

    this.transport = new StreamableHTTPClientTransport(new URL(this.url), transportOpts);

    this.client = new Client({ name: 'airlock', version: VERSION });

    this.transport.onclose = () => {
      this.ready = false;
      if (!this.stopped && !this.awaitingAuth) {
        if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
          log.error(
            { id: this.id },
            'HTTP MCP gave up reconnecting after %d attempts',
            MAX_RECONNECT_ATTEMPTS
          );
          return;
        }
        const delay = BACKOFF_STEPS[Math.min(this.reconnectAttempt, BACKOFF_STEPS.length - 1)];
        log.warn(
          { id: this.id, attempt: this.reconnectAttempt, delay },
          'HTTP MCP disconnected, reconnecting'
        );
        this.reconnectAttempt++;
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = undefined;
          void this.connect().catch((err) =>
            log.error({ id: this.id, reason: friendlyError(err) }, 'HTTP MCP reconnect failed')
          );
        }, delay);
      }
    };

    try {
      await this.client.connect(this.transport);
      this.reconnectAttempt = 0;
      this.ready = true;
      log.info({ id: this.id, url: this.url }, 'MCP HTTP client connected');
      this.notifyReady();
    } catch (err) {
      if (err instanceof UnauthorizedError && this.oauthProvider) {
        // Run the browser auth flow in the background so it doesn't block
        // gateway startup (pool.initialize waits for all connect() calls).
        void this.runOAuthFlow().catch((oauthErr) =>
          log.error({ id: this.id, reason: friendlyError(oauthErr) }, 'OAuth flow failed')
        );
        return;
      }
      log.error({ id: this.id, reason: friendlyError(err) }, 'MCP HTTP connect failed');
      throw err;
    }
  }

  /**
   * Run the full browser OAuth flow: wait for the user to authorize in the
   * browser, finish the auth exchange, then reconnect with fresh tokens.
   */
  private async runOAuthFlow(): Promise<void> {
    this.awaitingAuth = true;
    try {
      log.info({ id: this.id }, 'OAuth authorization required, waiting for browser flow');
      const code = await this.oauthProvider!.waitForAuthCode();
      await this.transport!.finishAuth(code);
    } finally {
      this.awaitingAuth = false;
    }
    // Tokens are now persisted by the provider. Reconnect with a fresh
    // transport — the old one was already started and cannot be reused.
    await this.connect();
  }

  async listTools(): Promise<Tool[]> {
    return this.withSessionRetry('listTools', async () => {
      if (!this.client || !this.ready) throw new Error(`MCP ${this.id} not connected`);
      const result = await this.client.listTools();
      return result.tools;
    });
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    requestMeta?: McpRequestMeta
  ): Promise<unknown> {
    return this.withSessionRetry('callTool', async () => {
      if (!this.client || !this.ready) throw new Error(`MCP ${this.id} not connected`);
      const request = requestMeta
        ? { name, arguments: args, _meta: requestMeta }
        : { name, arguments: args };
      return this.client.callTool(request);
    });
  }

  getServerInfo(): { name: string; version: string } | undefined {
    return this.client?.getServerVersion();
  }

  isReady(): boolean {
    return this.ready;
  }

  private notifyReady(): void {
    for (const cb of this.readyListeners) {
      cb();
    }
  }

  private async withSessionRetry<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (!isInvalidSessionError(err)) throw err;
      log.warn(
        { id: this.id, operation, reason: friendlyError(err) },
        'HTTP MCP session invalid, reconnecting'
      );
      this.ready = false;
      const oldTransport = this.transport;
      if (oldTransport) oldTransport.onclose = undefined;
      await oldTransport
        ?.close()
        .catch((closeErr) =>
          log.debug({ id: this.id, reason: friendlyError(closeErr) }, 'HTTP MCP close failed')
        );
      await this.connect();
      return fn();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.oauthProvider?.stopCallbackServer();
    await this.transport?.close();
  }
}
