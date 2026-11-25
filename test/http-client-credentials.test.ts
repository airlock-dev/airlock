/**
 * Tests for the client-credentials wiring in HttpMcpClient — the transport-level `fetch` seam that
 * stamps the app token onto every request.
 *
 * The token source itself is covered in client-credentials.test.ts and is mocked here; what these
 * tests pin down is the wiring: the header actually lands, a 401 buys exactly one forced re-mint,
 * and a dead client secret surfaces as `auth_required` rather than as a network outage.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ClientCredentialsConfig } from '../src/config/schema.js';

const transportOptions: Array<Record<string, unknown>> = [];
const mockClientInstances: Array<{
  connect: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
}> = [];
let nextConnectImpl: (() => Promise<void>) | undefined;
let nextCallToolImpl: ((req: unknown, opts?: unknown) => Promise<unknown>) | undefined;

// v2 exports Client and the transport from one module; keep the real exports (auth,
// UnauthorizedError, ...) and override only the two symbols HttpMcpClient constructs.
vi.mock('@modelcontextprotocol/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@modelcontextprotocol/client')>()),
  StreamableHTTPClientTransport: vi.fn().mockImplementation((_url, opts) => {
    transportOptions.push(opts ?? {});
    return {
      onclose: null as (() => void) | null,
      finishAuth: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      terminateSession: vi.fn().mockResolvedValue(undefined),
    };
  }),
  Client: vi.fn().mockImplementation(() => {
    const connect = vi.fn().mockImplementation(() => {
      const impl = nextConnectImpl;
      nextConnectImpl = undefined;
      return impl ? impl() : Promise.resolve(undefined);
    });
    const callTool = vi.fn().mockImplementation((req: unknown, opts?: unknown) => {
      const impl = nextCallToolImpl;
      nextCallToolImpl = undefined;
      return impl ? impl(req, opts) : Promise.resolve({ content: [] });
    });
    mockClientInstances.push({ connect, callTool });
    return {
      connect,
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
      callTool,
      getServerVersion: vi.fn(),
      getInstructions: vi.fn(),
    };
  }),
}));

let getToken: ReturnType<typeof vi.fn>;
let lastAuthFailure: string | undefined;
vi.mock('../src/pool/client-credentials.js', () => ({
  ClientCredentialsTokenSource: vi.fn().mockImplementation(() => ({
    getToken: (force?: boolean) => getToken(force),
    get lastAuthFailure() {
      return lastAuthFailure;
    },
  })),
}));

const { HttpMcpClient } = await import('../src/pool/http-client.js');

const CC: ClientCredentialsConfig = {
  token_url: 'https://issuer.example/oauth/token',
  client_id: 'cid',
  client_secret: 'csecret',
  scope: 'read,write',
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  transportOptions.length = 0;
  mockClientInstances.length = 0;
  nextConnectImpl = undefined;
  nextCallToolImpl = undefined;
  lastAuthFailure = undefined;
  getToken = vi.fn().mockResolvedValue('tok-1');
  fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

/** Connect a client-credentials provider and hand back the transport's injected fetch. */
async function connectAndGetFetch(): Promise<
  (url: string, init?: RequestInit) => Promise<Response>
> {
  const client = new HttpMcpClient(
    'linearBot',
    'https://mcp.example.com/mcp',
    undefined,
    false,
    18432,
    undefined,
    undefined,
    undefined,
    CC
  );
  await client.connect();
  return transportOptions[0].fetch as (url: string, init?: RequestInit) => Promise<Response>;
}

describe('HttpMcpClient with client_credentials', () => {
  it('injects the app token as a bearer header', async () => {
    const authedFetch = await connectAndGetFetch();
    await authedFetch('https://mcp.example.com/mcp', { method: 'POST', body: '{}' });

    const headers = fetchMock.mock.calls[0][1].headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer tok-1');
  });

  it('preserves caller headers alongside the injected one', async () => {
    const authedFetch = await connectAndGetFetch();
    await authedFetch('https://mcp.example.com/mcp', {
      method: 'POST',
      headers: { 'X-Trace': 'abc' },
      body: '{}',
    });

    const headers = fetchMock.mock.calls[0][1].headers as Headers;
    expect(headers.get('X-Trace')).toBe('abc');
    expect(headers.get('Authorization')).toBe('Bearer tok-1');
  });

  it('does not inject auth headers for providers without client_credentials', async () => {
    const client = new HttpMcpClient('plain', 'https://mcp.example.com/mcp');
    await client.connect();
    const customFetch = transportOptions[0].fetch as
      | ((url: string, init?: RequestInit) => Promise<Response>)
      | undefined;
    if (customFetch) {
      await customFetch('https://mcp.example.com/mcp', { method: 'POST', body: '{}' });
      const passedInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
      expect(new Headers(passedInit?.headers).get('Authorization')).toBeNull();
    }
    expect(getToken).not.toHaveBeenCalled();
  });

  it('forces a re-mint and retries once on 401', async () => {
    getToken = vi.fn().mockResolvedValueOnce('stale').mockResolvedValueOnce('fresh');
    fetchMock
      .mockResolvedValueOnce(new Response('nope', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const authedFetch = await connectAndGetFetch();
    const res = await authedFetch('https://mcp.example.com/mcp', { method: 'POST', body: '{}' });

    expect(res.status).toBe(200);
    expect(getToken).toHaveBeenNthCalledWith(2, true);
    expect((fetchMock.mock.calls[1][1].headers as Headers).get('Authorization')).toBe(
      'Bearer fresh'
    );
  });

  it('gives up after one retry rather than looping on a persistent 401', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 401 }));

    const authedFetch = await connectAndGetFetch();
    const res = await authedFetch('https://mcp.example.com/mcp', { method: 'POST', body: '{}' });

    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a streaming body it cannot replay', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 401 }));

    const authedFetch = await connectAndGetFetch();
    const body = new ReadableStream();
    const res = await authedFetch('https://mcp.example.com/mcp', { method: 'POST', body });

    expect(res.status).toBe(401);
    // One attempt only — a replay would have sent an empty body and failed for a confusing reason.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a rejected client secret as auth_required, not as an outage', async () => {
    // A fatal mint failure makes connect() throw, so this is the state the health endpoint sees:
    // never connected, with a token source that knows why.
    lastAuthFailure = 'client credentials rejected: invalid_client';
    const client = new HttpMcpClient(
      'linearBot',
      'https://mcp.example.com/mcp',
      undefined,
      false,
      18432,
      undefined,
      undefined,
      undefined,
      CC
    );

    expect(client.getConnectionStatus()).toEqual({
      status: 'auth_required',
      reason: 'client credentials rejected: invalid_client',
    });
  });

  it('re-runs beforeSend after token mint and before 401 retry in clientCredentialsFetch', async () => {
    let active = true;
    getToken = vi
      .fn()
      .mockImplementationOnce(async () => {
        // Initial token mint succeeds while upload is still active
        return 'tok-1';
      })
      .mockImplementationOnce(async () => {
        // Revoke during 401 re-mint — the retry fetch MUST NOT fire
        active = false;
        return 'tok-2';
      });
    fetchMock
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const client = new HttpMcpClient(
      'linearBot',
      'https://mcp.example.com/mcp',
      undefined,
      false,
      18432,
      undefined,
      undefined,
      undefined,
      CC
    );
    await client.connect();
    const authedFetch = transportOptions[0].fetch as (
      url: string,
      init?: RequestInit
    ) => Promise<Response>;

    nextCallToolImpl = async () => {
      await authedFetch('https://mcp.example.com/mcp', { method: 'POST', body: '{"secret":1}' });
      return { content: [] };
    };

    await expect(
      client.callTool('upload', { data: 'bytes' }, undefined, () => {
        if (!active) throw new Error('Upload revoked');
      })
    ).rejects.toThrow(/Upload revoked/);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Also block the very first fetch when revoked during the initial token fetch
    fetchMock.mockClear();
    let initialActive = true;
    getToken = vi.fn().mockImplementationOnce(async () => {
      initialActive = false;
      return 'tok-late';
    });
    nextCallToolImpl = async () => {
      await authedFetch('https://mcp.example.com/mcp', { method: 'POST', body: '{"secret":2}' });
      return { content: [] };
    };
    await expect(
      client.callTool('upload', { data: 'bytes' }, undefined, () => {
        if (!initialActive) throw new Error('Upload revoked during initial mint');
      })
    ).rejects.toThrow(/Upload revoked during initial mint/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-runs beforeSend after session-invalid reconnect before resending callTool', async () => {
    const client = new HttpMcpClient('plain', 'https://mcp.example.com/mcp');
    await client.connect();

    let active = true;
    nextCallToolImpl = async () => {
      throw new Error('Invalid or expired session ID');
    };
    nextConnectImpl = async () => {
      // Revoke while the HTTP transport is reconnecting
      active = false;
    };

    await expect(
      client.callTool('upload', { data: 'bytes' }, undefined, () => {
        if (!active) throw new Error('Upload revoked during reconnect');
      })
    ).rejects.toThrow(/Upload revoked during reconnect/);

    // Reconnect succeeded for the pool, but the second client instance NEVER dispatched callTool
    expect(mockClientInstances).toHaveLength(2);
    expect(mockClientInstances[0].callTool).toHaveBeenCalledTimes(1);
    expect(mockClientInstances[1].callTool).not.toHaveBeenCalled();
  });

  it('guards plain transport fetch calls with beforeSend across async boundaries', async () => {
    const client = new HttpMcpClient('plain', 'https://mcp.example.com/mcp');
    await client.connect();
    const guardedFetch = transportOptions[0].fetch as (
      url: string,
      init?: RequestInit
    ) => Promise<Response>;

    let active = true;
    nextCallToolImpl = async () => {
      await Promise.resolve();
      active = false;
      await guardedFetch('https://mcp.example.com/mcp', { method: 'POST', body: '{"data":1}' });
      return { content: [] };
    };

    await expect(
      client.callTool('upload', { data: 'bytes' }, undefined, () => {
        if (!active) throw new Error('Upload revoked before transport fetch');
      })
    ).rejects.toThrow(/Upload revoked before transport fetch/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
