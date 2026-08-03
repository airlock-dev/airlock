import { describe, it, expect, vi, beforeEach } from 'vitest';

type MockClient = {
  connect: ReturnType<typeof vi.fn>;
  listTools: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
  getServerVersion: ReturnType<typeof vi.fn>;
  options?: {
    listChanged?: {
      tools?: {
        autoRefresh?: boolean;
        debounceMs?: number;
        onChanged: (error: Error | null, tools: unknown[] | null) => void;
      };
    };
  };
};

const clients: MockClient[] = [];

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi
    .fn()
    .mockImplementation((_info: unknown, options: MockClient['options'] | undefined) => {
      const client: MockClient = {
        connect: vi.fn().mockResolvedValue(undefined),
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
        callTool: vi.fn().mockResolvedValue({ content: [] }),
        getServerVersion: vi.fn(),
        options,
      };
      clients.push(client);
      return client;
    }),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({
    onclose: undefined,
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: vi.fn().mockImplementation(() => ({
    onclose: undefined,
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(() => ({
    onclose: undefined,
    close: vi.fn().mockResolvedValue(undefined),
    terminateSession: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../src/pool/oauth-provider.js', () => ({
  FileOAuthProvider: vi.fn(),
}));

const { StdioMcpClient } = await import('../src/pool/stdio-client.js');
const { SseMcpClient } = await import('../src/pool/sse-client.js');
const { HttpMcpClient } = await import('../src/pool/http-client.js');

beforeEach(() => {
  clients.length = 0;
});

describe('MCP client tools/list proxying', () => {
  const factories = [
    () => new StdioMcpClient('stdio', 'node', []),
    () => new SseMcpClient('sse', 'https://example.com/sse'),
    () => new HttpMcpClient('http', 'https://example.com/mcp'),
  ];

  it.each(factories)('fetches every tools/list page (%#)', async (factory) => {
    const client = factory();
    await client.connect();
    const upstream = clients[0];
    upstream.listTools
      .mockResolvedValueOnce({
        tools: [
          {
            name: 'first',
            inputSchema: { type: 'object' },
            outputSchema: { type: 'object', properties: { first: { type: 'string' } } },
          },
        ],
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({
        tools: [
          {
            name: 'second',
            inputSchema: { type: 'object' },
            execution: { taskSupport: 'optional' },
          },
        ],
      });

    await expect(client.listTools()).resolves.toEqual([
      {
        name: 'first',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object', properties: { first: { type: 'string' } } },
      },
      {
        name: 'second',
        inputSchema: { type: 'object' },
        execution: { taskSupport: 'optional' },
      },
    ]);
    const requestOptions = client instanceof HttpMcpClient ? [{ timeout: 60_000 }] : [];
    expect(upstream.listTools).toHaveBeenNthCalledWith(1, undefined, ...requestOptions);
    expect(upstream.listTools).toHaveBeenNthCalledWith(2, { cursor: 'page-2' }, ...requestOptions);

    await client.stop();
  });

  it.each(factories)('rejects a repeated tools/list cursor (%#)', async (factory) => {
    const client = factory();
    await client.connect();
    clients[0].listTools.mockResolvedValue({ tools: [], nextCursor: 'same' });

    await expect(client.listTools()).rejects.toThrow(/repeated tools\/list cursor/);
    await client.stop();
  });

  it.each(factories)('notifies the pool seam on tools/list_changed (%#)', async (factory) => {
    const client = factory();
    const changed = vi.fn();
    client.onToolsChanged(changed);
    await client.connect();

    const options = clients[0].options?.listChanged?.tools;
    expect(options).toMatchObject({ autoRefresh: false, debounceMs: 0 });
    options?.onChanged(null, null);
    expect(changed).toHaveBeenCalledTimes(1);

    await client.stop();
  });
});
