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

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation((_url, opts) => {
    transportOptions.push(opts ?? {});
    return {
      onclose: null as (() => void) | null,
      finishAuth: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      terminateSession: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({ tools: [] }),
    callTool: vi.fn().mockResolvedValue({ content: [] }),
    getServerVersion: vi.fn(),
    getInstructions: vi.fn(),
  })),
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

  it('does not install a fetch override for providers without client_credentials', async () => {
    const client = new HttpMcpClient('plain', 'https://mcp.example.com/mcp');
    await client.connect();
    expect(transportOptions[0].fetch).toBeUndefined();
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
});
