import { describe, it, expect, afterEach, vi } from 'vitest';
import { ClientPool } from '../src/pool/pool.js';
import { HttpMcpClient } from '../src/pool/http-client.js';
import { McpServerConfig } from '../src/config/schema.js';

function http(url: string): McpServerConfig {
  return McpServerConfig.parse({ type: 'http', url });
}

describe('ClientPool.reload', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
});
