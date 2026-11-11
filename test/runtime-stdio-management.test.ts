import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server, type AddressInfo } from 'net';
import { runStdioMode } from '../src/stdio-mode.js';
import * as stdioServerModule from '../src/transport/stdio-server.js';
import { GatewayConfig } from '../src/config/schema.js';

function listenOnFreePort(): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('stdio mode management API', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))
    );
  });

  it('keeps the session running when another process holds the management port', async () => {
    const occupied = await listenOnFreePort();
    servers.push(occupied);
    const port = (occupied.address() as AddressInfo).port;

    const config = GatewayConfig.parse({
      agents: { 'claude-code': { token: 'agent-secret', allow: ['http/get'] } },
      approvals: { provider: { type: 'webhook', url: 'http://localhost:9999/hook' } },
      audit: { db_path: ':memory:' },
      server: {
        port: 4111,
        host: '127.0.0.1',
        management_api: { enabled: true, api_secret: 'admin-secret', port, host: '127.0.0.1' },
      },
    });
    const stdioSpy = vi.spyOn(stdioServerModule, 'runStdioServer').mockResolvedValue();

    await expect(runStdioMode(config, 'claude-code', '')).resolves.toBeUndefined();
    expect(stdioSpy).toHaveBeenCalledOnce();
  });
});
