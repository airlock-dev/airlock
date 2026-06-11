/**
 * Tests for HttpMcpClient — specifically the OAuth reconnect flow.
 *
 * The bug this guards against: after the user completes the browser OAuth flow,
 * the client tried to call `this.client.connect(this.transport)` on the same
 * transport that was already started, causing:
 *   "StreamableHTTPClientTransport already started!"
 *
 * The fix: call `this.connect()` recursively after `finishAuth()`, which creates
 * a fresh transport with the persisted tokens.
 *
 * Note: the OAuth flow runs in the background (not awaited by connect()) so the
 * gateway can start listening immediately. Tests use vi.waitFor() or flushes to
 * let the background flow settle.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';

// ─── Module mocks (hoisted) ──────────────────────────────────────────────────

// Track every StreamableHTTPClientTransport instance created so we can assert
// how many were constructed and that they're distinct objects.
const transportInstances: {
  finishAuth: ReturnType<typeof vi.fn>;
  onclose: (() => void) | null;
  close: ReturnType<typeof vi.fn>;
}[] = [];

const clientInstances: {
  connect: ReturnType<typeof vi.fn>;
  listTools: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
  getServerVersion: ReturnType<typeof vi.fn>;
}[] = [];

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => {
  return {
    StreamableHTTPClientTransport: vi.fn().mockImplementation(() => {
      const t = {
        onclose: null as (() => void) | null,
        finishAuth: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      transportInstances.push(t);
      return t;
    }),
  };
});

// Client.connect() throws UnauthorizedError only on the very first call.
let clientConnectCallCount = 0;
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  return {
    Client: vi.fn().mockImplementation(() => {
      const client = {
        connect: vi.fn().mockImplementation(async () => {
          clientConnectCallCount++;
          if (clientConnectCallCount === 1) {
            throw new UnauthorizedError('OAuth required');
          }
          // Subsequent connects succeed — tokens are now present
        }),
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
        callTool: vi.fn().mockResolvedValue({ content: [] }),
        getServerVersion: vi.fn(),
      };
      clientInstances.push(client);
      return client;
    }),
  };
});

// FileOAuthProvider: waitForAuthCode resolves immediately; no file I/O, no browser.
vi.mock('../src/pool/oauth-provider.js', () => {
  return {
    FileOAuthProvider: vi.fn().mockImplementation(() => ({
      waitForAuthCode: vi.fn().mockResolvedValue('mock-auth-code'),
      stopCallbackServer: vi.fn(),
    })),
  };
});

// ─── Import under test (after mocks are registered) ──────────────────────────

const { HttpMcpClient } = await import('../src/pool/http-client.js');

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  transportInstances.length = 0;
  clientInstances.length = 0;
  clientConnectCallCount = 0;
  vi.clearAllMocks();
});

/** Helper: flush microtasks so the background OAuth flow settles. */
async function flushOAuthFlow(): Promise<void> {
  // The background flow chains several awaits (waitForAuthCode → finishAuth →
  // recursive connect). Flushing a few microtask rounds lets them all resolve.
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe('HttpMcpClient — OAuth reconnect', () => {
  it('creates a new transport after OAuth (does not reuse the already-started one)', async () => {
    const client = new HttpMcpClient('supabase', 'https://mcp.supabase.com/mcp', undefined, true);
    await client.connect();
    await flushOAuthFlow();

    // Should have created exactly two transports:
    //   1st: used for initial connect → UnauthorizedError → finishAuth
    //   2nd: created by the recursive connect() → succeeds
    expect(transportInstances).toHaveLength(2);
    expect(transportInstances[0]).not.toBe(transportInstances[1]);
  });

  it('is ready after a successful OAuth flow', async () => {
    const client = new HttpMcpClient('supabase', 'https://mcp.supabase.com/mcp', undefined, true);
    await client.connect();
    await flushOAuthFlow();
    expect(client.isReady()).toBe(true);
  });

  it('notifies listeners after OAuth reconnect becomes ready', async () => {
    const client = new HttpMcpClient('supabase', 'https://mcp.supabase.com/mcp', undefined, true);
    const onReady = vi.fn();
    client.onReady(onReady);

    await client.connect();
    expect(onReady).not.toHaveBeenCalled();

    await flushOAuthFlow();
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('calls finishAuth on the first transport with the code from waitForAuthCode', async () => {
    const client = new HttpMcpClient('supabase', 'https://mcp.supabase.com/mcp', undefined, true);
    await client.connect();
    await flushOAuthFlow();
    expect(transportInstances[0].finishAuth).toHaveBeenCalledWith('mock-auth-code');
  });

  it('does not call finishAuth on the new transport', async () => {
    const client = new HttpMcpClient('supabase', 'https://mcp.supabase.com/mcp', undefined, true);
    await client.connect();
    await flushOAuthFlow();
    expect(transportInstances[1].finishAuth).not.toHaveBeenCalled();
  });

  it('awaitingAuth is false after OAuth flow completes', async () => {
    // If awaitingAuth stayed true, any subsequent connect() call would be silently
    // skipped (the guard at the top of connect()). Verify it creates a new transport
    // when connect() is called again after the OAuth flow finishes.
    const client = new HttpMcpClient('supabase', 'https://mcp.supabase.com/mcp', undefined, true);
    await client.connect();
    await flushOAuthFlow();
    expect(client.isReady()).toBe(true);

    const countBefore = transportInstances.length;
    // If awaitingAuth were still true this would silently return without creating a transport
    await client.connect();
    expect(transportInstances.length).toBeGreaterThan(countBefore);
  });
});

describe('HttpMcpClient — plain header auth (no OAuth)', () => {
  it('connects successfully with a static auth header', async () => {
    clientConnectCallCount = 1; // skip the UnauthorizedError — no OAuth flow
    const client = new HttpMcpClient(
      'posthog',
      'https://mcp.posthog.com/mcp',
      { Authorization: 'Bearer test-token' },
      false
    );
    const onReady = vi.fn();
    client.onReady(onReady);

    await client.connect();
    expect(client.isReady()).toBe(true);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(transportInstances).toHaveLength(1);
  });

  it('does not start OAuth flow for non-401 errors', async () => {
    // Make connect throw a generic error (not UnauthorizedError)
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    (Client as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      connect: vi.fn().mockRejectedValue(new Error('Network error')),
      listTools: vi.fn(),
      callTool: vi.fn(),
      getServerVersion: vi.fn(),
    }));

    const { FileOAuthProvider } = await import('../src/pool/oauth-provider.js');
    const client = new HttpMcpClient('posthog', 'https://mcp.posthog.com/mcp', undefined, true);
    await expect(client.connect()).rejects.toThrow('Network error');
    // waitForAuthCode should never have been called
    const providerInstance = (FileOAuthProvider as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    expect(providerInstance?.waitForAuthCode).not.toHaveBeenCalled();
  });
});

describe('HttpMcpClient — reconnect backoff', () => {
  it('schedules reconnect after disconnect', async () => {
    clientConnectCallCount = 1; // first connect succeeds
    const client = new HttpMcpClient('railway', 'https://example.com/mcp');
    await client.connect();
    expect(client.isReady()).toBe(true);

    // Trigger onclose to simulate the server dropping the connection
    const firstTransport = transportInstances[0];
    clientConnectCallCount = 1; // next connect also succeeds
    firstTransport.onclose?.();

    await new Promise((r) => setTimeout(r, 1100)); // wait past first backoff step (1000ms)
    expect(transportInstances.length).toBeGreaterThanOrEqual(2);
  });

  it('does not reconnect after stop()', async () => {
    clientConnectCallCount = 1;
    const client = new HttpMcpClient('railway', 'https://example.com/mcp');
    await client.connect();

    await client.stop();
    const countBefore = transportInstances.length;

    // Onclose fires after stop — should be ignored
    transportInstances[0].onclose?.();
    await new Promise((r) => setTimeout(r, 50));
    expect(transportInstances.length).toBe(countBefore);
  });
});

describe('HttpMcpClient — stale Streamable HTTP session recovery', () => {
  it('reconnects and retries listTools once when the server rejects the cached session', async () => {
    clientConnectCallCount = 1;
    const client = new HttpMcpClient('amoura', 'https://mcp.amoura.io/mcp');
    await client.connect();

    clientInstances[0].listTools.mockRejectedValueOnce(
      new Error('Bad Request: No valid session ID provided')
    );

    await expect(client.listTools()).resolves.toEqual([]);
    expect(transportInstances).toHaveLength(2);
    expect(transportInstances[0].close).toHaveBeenCalledTimes(1);
    expect(clientInstances[0].listTools).toHaveBeenCalledTimes(1);
    expect(clientInstances[1].listTools).toHaveBeenCalledTimes(1);
  });

  it('reconnects and retries callTool once when the server rejects the cached session', async () => {
    clientConnectCallCount = 1;
    const client = new HttpMcpClient('amoura', 'https://mcp.amoura.io/mcp');
    await client.connect();

    clientInstances[0].callTool.mockRejectedValueOnce(new Error('Session not found: stale-id'));

    await expect(client.callTool('health_get_health_status', {})).resolves.toEqual({
      content: [],
    });
    expect(transportInstances).toHaveLength(2);
    expect(transportInstances[0].close).toHaveBeenCalledTimes(1);
    expect(clientInstances[1].callTool).toHaveBeenCalledWith({
      name: 'health_get_health_status',
      arguments: {},
    });
  });

  it('does not reconnect for non-session tool errors', async () => {
    clientConnectCallCount = 1;
    const client = new HttpMcpClient('amoura', 'https://mcp.amoura.io/mcp');
    await client.connect();

    clientInstances[0].callTool.mockRejectedValueOnce(new Error('Bad Request: invalid payload'));

    await expect(client.callTool('health_get_health_status', {})).rejects.toThrow(
      'Bad Request: invalid payload'
    );
    expect(transportInstances).toHaveLength(1);
    expect(transportInstances[0].close).not.toHaveBeenCalled();
  });
});
