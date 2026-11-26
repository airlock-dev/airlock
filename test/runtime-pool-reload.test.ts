import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, loadConfigDetailed } from '../src/config/loader.js';
import { discoverTools } from '../src/configure-web/cli.js';
import { ClientPool } from '../src/pool/pool.js';
import { HttpMcpClient } from '../src/pool/http-client.js';
import { getMcpConfigs, McpServerConfig } from '../src/config/schema.js';

function http(url: string): McpServerConfig {
  return McpServerConfig.parse({ type: 'http', url });
}

describe('ClientPool.reload', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('adds a file-authenticated provider without interrupting an existing call', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'airlock-hot-add-'));
    const configFile = join(directory, 'airlock.yaml');
    const tokenFile = join(directory, 'bearer');
    const existing =
      'providers:\n  existing:\n    type: http\n    url: https://existing.example.com\n';
    const added = `${existing}  added:
    type: http
    url: https://added.example.com
    bearer_token_file: ${JSON.stringify(tokenFile)}
`;
    const connected: { url: string; headers?: Record<string, string> }[] = [];
    vi.spyOn(HttpMcpClient.prototype, 'connect').mockImplementation(async function (
      this: HttpMcpClient
    ) {
      const { url, headers } = this as unknown as (typeof connected)[number];
      connected.push({ url, headers });
    });
    const stop = vi.spyOn(HttpMcpClient.prototype, 'stop').mockResolvedValue();
    vi.spyOn(HttpMcpClient.prototype, 'isReady').mockReturnValue(true);
    let finishCall!: (result: unknown) => void;
    vi.spyOn(HttpMcpClient.prototype, 'callTool').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishCall = resolve;
        })
    );
    writeFileSync(configFile, existing);
    const pool = new ClientPool(getMcpConfigs(loadConfig(configFile).providers), {
      healthCheck: false,
    });
    try {
      await pool.initialize();
      const inFlight = pool.callTool('existing', 'slow_read', {});
      writeFileSync(configFile, added);
      expect(() => loadConfig(configFile)).toThrow('readable file containing one bearer token');
      expect(loadConfigDetailed(configFile, { resolveEnv: false }).diagnostics).toEqual([]);
      writeFileSync(tokenFile, 'fixture-bearer\n', { mode: 0o600 });
      const { config, rawConfig } = loadConfigDetailed(configFile);
      expect(JSON.stringify(rawConfig)).not.toContain('fixture-bearer');
      await pool.reload(getMcpConfigs(config!.providers));
      expect(connected).toEqual([
        { url: 'https://existing.example.com' },
        { url: 'https://added.example.com', headers: { Authorization: 'Bearer fixture-bearer' } },
      ]);
      expect(stop).not.toHaveBeenCalled();
      finishCall('completed');
      await expect(inFlight).resolves.toBe('completed');

      writeFileSync(tokenFile, 'rotated-bearer\n');
      await pool.reload(getMcpConfigs(loadConfig(configFile).providers));
      expect(connected).toHaveLength(3);
      expect(connected[2]).toEqual({
        url: 'https://added.example.com',
        headers: { Authorization: 'Bearer rotated-bearer' },
      });
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      await pool.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses the bearer file for tool discovery from raw config', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'airlock-discovery-'));
    const configFile = join(directory, 'airlock.yaml');
    const tokenFile = join(directory, 'bearer');
    writeFileSync(tokenFile, 'fixture-discovery\n', { mode: 0o600 });
    writeFileSync(
      configFile,
      `providers:
  workspace:
    type: http
    url: https://workspace.example.com
    bearer_token_file: ${JSON.stringify(tokenFile)}
`
    );
    const connect = vi.spyOn(HttpMcpClient.prototype, 'connect').mockImplementation(async function (
      this: HttpMcpClient
    ) {
      const { headers } = this as unknown as { headers?: Record<string, string> };
      expect(headers?.Authorization).toBe('Bearer fixture-discovery');
    });
    vi.spyOn(HttpMcpClient.prototype, 'isReady').mockReturnValue(true);
    vi.spyOn(HttpMcpClient.prototype, 'listTools').mockResolvedValue([
      { name: 'list_items', inputSchema: { type: 'object' } },
    ]);
    vi.spyOn(HttpMcpClient.prototype, 'stop').mockResolvedValue();
    try {
      const result = await discoverTools(configFile);
      expect(connect).toHaveBeenCalledOnce();
      expect(result.errors).toEqual([]);
      expect(result.tools.map((tool) => tool.name)).toContain('workspace/list_items');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('restarts a provider whose config changed and leaves unchanged ones alone', async () => {
    const connected: string[] = [];
    vi.spyOn(HttpMcpClient.prototype, 'connect').mockImplementation(async function (
      this: HttpMcpClient
    ) {
      connected.push((this as unknown as { url: string }).url);
    });
    const stop = vi.spyOn(HttpMcpClient.prototype, 'stop').mockResolvedValue();

    const pool = new ClientPool(
      { changed: http('http://127.0.0.1:1/a'), same: http('http://127.0.0.1:1/same') },
      { healthCheck: false }
    );
    await pool.initialize();
    expect(connected.sort()).toEqual(['http://127.0.0.1:1/a', 'http://127.0.0.1:1/same']);

    connected.length = 0;
    await pool.reload({
      changed: http('http://127.0.0.1:1/b'),
      same: http('http://127.0.0.1:1/same'),
    });
    await vi.waitFor(() => expect(connected).toEqual(['http://127.0.0.1:1/b']));
    expect(stop).toHaveBeenCalledTimes(1);

    connected.length = 0;
    await pool.reload({
      changed: http('http://127.0.0.1:1/b'),
      same: http('http://127.0.0.1:1/same'),
    });
    expect(connected).toEqual([]);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(pool.getMcpIds().sort()).toEqual(['changed', 'same']);

    // Fields the client never reads, and key order, do not restart a provider.
    await pool.reload({
      changed: McpServerConfig.parse({
        url: 'http://127.0.0.1:1/b',
        type: 'http',
        instructions: 'Prefer search over list.',
        upstream_instructions: 'ignore',
      }),
      same: http('http://127.0.0.1:1/same'),
    });
    expect(connected).toEqual([]);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent reloads so an older slow stop cannot restore a stale upstream destination', async () => {
    const connected: string[] = [];
    vi.spyOn(HttpMcpClient.prototype, 'connect').mockImplementation(async function (
      this: HttpMcpClient
    ) {
      connected.push((this as unknown as { url: string }).url);
    });

    let releaseFirstStop!: () => void;
    let stopCount = 0;
    vi.spyOn(HttpMcpClient.prototype, 'stop').mockImplementation(() => {
      stopCount += 1;
      if (stopCount === 1) {
        return new Promise<void>((resolve) => {
          releaseFirstStop = resolve;
        });
      }
      return Promise.resolve();
    });

    const pool = new ClientPool({ svc: http('http://127.0.0.1:1/v1') }, { healthCheck: false });
    await pool.initialize();
    connected.length = 0;

    // Reload #1 starts stopping v1 -> v2; reload #2 (v3) and reload #3 (v4) arrive concurrently.
    const r1 = pool.reload({ svc: http('http://127.0.0.1:1/v2') });
    await vi.waitFor(() => expect(stopCount).toBe(1));
    const r2 = pool.reload({ svc: http('http://127.0.0.1:1/v3') });
    const r3 = pool.reload({ svc: http('http://127.0.0.1:1/v4') });

    releaseFirstStop();
    await Promise.all([r1, r2, r3]);

    // Reload #2 was superseded while queued (never connected v3), and the final client MUST be v4.
    expect(connected).not.toContain('http://127.0.0.1:1/v3');
    const activeClient = (pool as unknown as { clients: Map<string, { url: string }> }).clients.get(
      'svc'
    );
    expect(activeClient?.url).toBe('http://127.0.0.1:1/v4');
  });

  it('restarts an HTTP client when protocol_mode or client_credentials.auth_method changes', async () => {
    const modes: string[] = [];
    vi.spyOn(HttpMcpClient.prototype, 'connect').mockImplementation(async function (
      this: HttpMcpClient
    ) {
      modes.push((this as unknown as { protocolMode: string }).protocolMode);
    });
    const stop = vi.spyOn(HttpMcpClient.prototype, 'stop').mockResolvedValue();

    const pool = new ClientPool(
      {
        svc: McpServerConfig.parse({
          type: 'http',
          url: 'http://127.0.0.1:1/mcp',
          protocol_mode: 'auto',
          client_credentials: {
            token_url: 'https://auth.example.com/token',
            client_id: 'cid',
            client_secret: 'csec',
            auth_method: 'client_secret_basic',
          },
        }),
      },
      { healthCheck: false }
    );
    await pool.initialize();
    expect(modes).toEqual(['auto']);

    await pool.reload({
      svc: McpServerConfig.parse({
        type: 'http',
        url: 'http://127.0.0.1:1/mcp',
        protocol_mode: 'legacy',
        client_credentials: {
          token_url: 'https://auth.example.com/token',
          client_id: 'cid',
          client_secret: 'csec',
          auth_method: 'client_secret_basic',
        },
      }),
    });
    await vi.waitFor(() => expect(modes).toEqual(['auto', 'legacy']));
    expect(stop).toHaveBeenCalledTimes(1);

    await pool.reload({
      svc: McpServerConfig.parse({
        type: 'http',
        url: 'http://127.0.0.1:1/mcp',
        protocol_mode: 'legacy',
        client_credentials: {
          token_url: 'https://auth.example.com/token',
          client_id: 'cid',
          client_secret: 'csec',
          auth_method: 'client_secret_post',
        },
      }),
    });
    await vi.waitFor(() => expect(modes).toEqual(['auto', 'legacy', 'legacy']));
    expect(stop).toHaveBeenCalledTimes(2);
  });
});
