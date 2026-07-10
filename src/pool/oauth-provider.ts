import { chmod, readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { execFile } from 'child_process';
import { createServer, type Server as HttpServer } from 'http';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientMetadata,
  OAuthClientInformationFull,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { childLogger } from '../util/logger.js';

const log = childLogger('oauth');

interface PersistedData {
  clientInfo?: OAuthClientInformationFull;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

/**
 * File-backed OAuthClientProvider that persists tokens to ~/.airlock/oauth/<server-id>.json
 * and opens the browser for authorization.
 */
export class FileOAuthProvider implements OAuthClientProvider {
  private storePath: string;
  private data: PersistedData = {};
  private callbackServer?: HttpServer;
  private authCodeResolve?: (code: string) => void;
  private browserOpenedAt = 0;
  private expectedState?: string;

  constructor(
    private serverId: string,
    private callbackPort: number,
    private preregisteredClientId?: string,
    private preregisteredClientSecret?: string,
    private relayCallbackUrl?: string
  ) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '.';
    const dir = join(home, '.airlock', 'oauth');
    this.storePath = join(dir, `${serverId}.json`);
  }

  get redirectUrl(): string {
    if (this.relayCallbackUrl) {
      return this.relayCallbackUrl;
    }
    return `http://127.0.0.1:${this.callbackPort}/oauth/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      client_name: `Airlock (${this.serverId})`,
      token_endpoint_auth_method: this.preregisteredClientSecret ? 'client_secret_post' : 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
  }

  async clientInformation(): Promise<OAuthClientInformationFull | undefined> {
    // If pre-registered credentials were provided, use them directly
    // (skips dynamic client registration)
    if (this.preregisteredClientId) {
      return {
        client_id: this.preregisteredClientId,
        redirect_uris: [this.redirectUrl],
        ...(this.preregisteredClientSecret && {
          client_secret: this.preregisteredClientSecret,
        }),
      };
    }
    await this.load();
    const info = this.data.clientInfo;
    if (info?.redirect_uris?.length && !info.redirect_uris.includes(this.redirectUrl)) {
      log.info(
        {
          serverId: this.serverId,
          redirectUrl: this.redirectUrl,
          cachedRedirectUris: info.redirect_uris,
        },
        'Invalidating OAuth client registration because redirect URI changed'
      );
      this.data = {};
      await this.save();
      return undefined;
    }
    return this.data.clientInfo;
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    this.data.clientInfo = info;
    await this.save();
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    await this.load();
    return this.data.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    // Preserve an existing refresh_token when a refresh response omits one.
    // Many OAuth providers return refresh_token only on the initial authorization
    // (or rotate it and expect the client to retain the prior value until it is
    // replaced). Blindly overwriting would drop the refresh_token, so the next
    // access-token expiry would fail to refresh and force a full interactive
    // re-authorization — the exact failure that silently takes headless MCPs down.
    if (!tokens.refresh_token && this.data.tokens?.refresh_token) {
      tokens = { ...tokens, refresh_token: this.data.tokens.refresh_token };
    }
    this.data.tokens = tokens;
    await this.save();
  }

  async invalidateCredentials(scope: 'all' | 'tokens'): Promise<void> {
    log.info({ serverId: this.serverId, scope }, 'Invalidating OAuth credentials');
    if (scope === 'all') {
      this.data = {};
    } else {
      delete this.data.tokens;
    }
    await this.save();
  }

  redirectToAuthorization(url: URL): Promise<void> {
    const now = Date.now();
    if (now - this.browserOpenedAt < 30_000) {
      log.debug({ serverId: this.serverId }, 'Skipping duplicate browser open (debounced)');
      return Promise.resolve();
    }
    this.browserOpenedAt = now;

    // When using an HTTPS relay, wrap the state parameter with the local port
    // so the relay can redirect back to localhost after the OAuth provider responds.
    const originalState = url.searchParams.get('state') ?? '';
    this.expectedState = originalState;
    if (this.relayCallbackUrl) {
      url.searchParams.set('state', `${this.callbackPort}.${originalState}`);
    }

    log.info(
      { serverId: this.serverId, url: url.toString() },
      'Opening browser for OAuth authorization'
    );
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    execFile(cmd, [url.toString()]);
    return Promise.resolve();
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    this.data.codeVerifier = verifier;
    await this.save();
  }

  async codeVerifier(): Promise<string> {
    await this.load();
    return this.data.codeVerifier ?? '';
  }

  /**
   * Starts a temporary HTTP server to listen for the OAuth callback.
   * Returns a promise that resolves with the authorization code.
   */
  waitForAuthCode(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.authCodeResolve = resolve;

      this.callbackServer = createServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.callbackPort}`);
        if (url.pathname !== '/oauth/callback') {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        const state = url.searchParams.get('state');

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(
            '<html><body><h2>Authorization failed</h2><p>You can close this tab.</p></body></html>'
          );
          this.stopCallbackServer();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (code) {
          if (!this.isExpectedState(state)) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(
              '<html><body><h2>Authorization failed</h2><p>OAuth state mismatch.</p></body></html>'
            );
            this.stopCallbackServer();
            reject(new Error('OAuth state mismatch'));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h2>Authorized!</h2><p>You can close this tab.</p></body></html>');
          this.stopCallbackServer();
          this.authCodeResolve?.(code);
          return;
        }

        res.writeHead(400);
        res.end('Missing code parameter');
      });

      this.callbackServer.listen(this.callbackPort, '127.0.0.1', () => {
        log.info({ port: this.callbackPort }, 'OAuth callback server listening');
      });

      this.callbackServer.on('error', (err) => {
        log.error({ err }, 'OAuth callback server error');
        reject(err);
      });
    });
  }

  stopCallbackServer(): void {
    this.callbackServer?.close();
    this.callbackServer = undefined;
  }

  private isExpectedState(state: string | null): boolean {
    if (this.expectedState === undefined) return true;
    if (state === this.expectedState) return true;
    return this.relayCallbackUrl !== undefined && state === `${this.callbackPort}.${this.expectedState}`;
  }

  private async load(): Promise<void> {
    try {
      const data = await readFile(this.storePath, 'utf-8');
      this.data = JSON.parse(data) as PersistedData;
    } catch {
      this.data = {};
    }
  }

  private async save(): Promise<void> {
    const dir = join(this.storePath, '..');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => {});
    await writeFile(this.storePath, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    await chmod(this.storePath, 0o600).catch(() => {});
  }
}
