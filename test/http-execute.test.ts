import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeHttp } from '../src/tools/http.js';
import type { AgentConfig, SecurityConfig } from '../src/config/schema.js';

const DEFAULT_SECURITY: SecurityConfig = {
  blocked_hosts: ['localhost', '127.0.0.1', '::1', '*.local', '10.*', '192.168.*', '172.16.*'],
  allowed_local: [],
};

function makeAgentConfig(httpOverrides: Partial<AgentConfig['http']> = {}): AgentConfig {
  return {
    allow: ['http/*'],
    hitl: [],
    tool_overrides: {},
    exec: { allow: [], hitl: [], deny: [], env: {}, default_timeout_ms: 5000 },
    http: {
      domain_allowlist: [],
      max_response_bytes: 1048576,
      timeout_ms: 5000,
      ...httpOverrides,
    },
  };
}

function makeReadableBody(body: string) {
  const buf = Buffer.from(body);
  let read = false;
  return {
    getReader() {
      return {
        async read() {
          if (read) return { done: true, value: undefined };
          read = true;
          return { done: false, value: new Uint8Array(buf) };
        },
        cancel() {},
      };
    },
  };
}

function mockFetch(status: number, body: string, headers: Record<string, string> = {}) {
  const headersMap = new Map(Object.entries({ 'content-type': 'text/plain', ...headers }));
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { forEach: (cb: (v: string, k: string) => void) => headersMap.forEach(cb) },
    body: makeReadableBody(body),
  });
}

describe('executeHttp() — security enforcement', () => {
  it('blocks localhost', async () => {
    await expect(
      executeHttp('get', { url: 'http://localhost/api' }, makeAgentConfig(), DEFAULT_SECURITY),
    ).rejects.toThrow(/[Bb]locked/);
  });

  it('blocks 127.0.0.1', async () => {
    await expect(
      executeHttp('get', { url: 'http://127.0.0.1/api' }, makeAgentConfig(), DEFAULT_SECURITY),
    ).rejects.toThrow(/[Bb]locked/);
  });

  it('blocks 192.168.x.x', async () => {
    await expect(
      executeHttp('get', { url: 'http://192.168.1.100/api' }, makeAgentConfig(), DEFAULT_SECURITY),
    ).rejects.toThrow(/[Bb]locked/);
  });

  it('allows localhost when in allowed_local', async () => {
    const security = { ...DEFAULT_SECURITY, allowed_local: ['localhost'] };
    const fetch = mockFetch(200, 'ok');
    vi.stubGlobal('fetch', fetch);
    await expect(
      executeHttp('get', { url: 'http://localhost/api' }, makeAgentConfig(), security),
    ).resolves.toBeDefined();
    vi.unstubAllGlobals();
  });

  it('blocks domain not in agent allowlist', async () => {
    const agent = makeAgentConfig({ domain_allowlist: ['api.example.com'] });
    await expect(
      executeHttp('get', { url: 'https://evil.com/steal' }, agent, DEFAULT_SECURITY),
    ).rejects.toThrow(/[Dd]omain/);
  });

  it('allows domain in agent allowlist', async () => {
    const fetch = mockFetch(200, 'hello');
    vi.stubGlobal('fetch', fetch);
    const agent = makeAgentConfig({ domain_allowlist: ['api.example.com'] });
    const result = await executeHttp('get', { url: 'https://api.example.com/data' }, agent, DEFAULT_SECURITY);
    expect(result.status).toBe(200);
    vi.unstubAllGlobals();
  });

  it('empty domain_allowlist allows all non-blocked domains', async () => {
    const fetch = mockFetch(200, 'hello');
    vi.stubGlobal('fetch', fetch);
    const result = await executeHttp('get', { url: 'https://api.github.com/repos' }, makeAgentConfig(), DEFAULT_SECURITY);
    expect(result.status).toBe(200);
    vi.unstubAllGlobals();
  });

  it('throws on invalid URL', async () => {
    await expect(
      executeHttp('get', { url: 'not-a-url' }, makeAgentConfig(), DEFAULT_SECURITY),
    ).rejects.toThrow(/[Ii]nvalid URL/);
  });
});

describe('executeHttp() — request execution', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns status, headers, and body', async () => {
    const fetch = mockFetch(200, 'hello world', { 'x-custom': 'value' });
    vi.stubGlobal('fetch', fetch);
    const result = await executeHttp('get', { url: 'https://api.example.com/' }, makeAgentConfig(), DEFAULT_SECURITY);
    expect(result.status).toBe(200);
    expect(result.body).toBe('hello world');
    expect(result.headers['x-custom']).toBe('value');
  });

  it('passes method correctly', async () => {
    const fetch = mockFetch(201, '');
    vi.stubGlobal('fetch', fetch);
    await executeHttp('post', { url: 'https://api.example.com/', body: '{"x":1}' }, makeAgentConfig(), DEFAULT_SECURITY);
    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.com/',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('sends body for POST', async () => {
    const fetch = mockFetch(200, '');
    vi.stubGlobal('fetch', fetch);
    await executeHttp('post', { url: 'https://api.example.com/', body: '{"key":"val"}' }, makeAgentConfig(), DEFAULT_SECURITY);
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: '{"key":"val"}' }),
    );
  });

  it('does not send body for GET', async () => {
    const fetch = mockFetch(200, '');
    vi.stubGlobal('fetch', fetch);
    await executeHttp('get', { url: 'https://api.example.com/' }, makeAgentConfig(), DEFAULT_SECURITY);
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: undefined }),
    );
  });

  it('passes custom headers', async () => {
    const fetch = mockFetch(200, '');
    vi.stubGlobal('fetch', fetch);
    await executeHttp('get', { url: 'https://api.example.com/', headers: { 'x-api-key': 'secret' } }, makeAgentConfig(), DEFAULT_SECURITY);
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: { 'x-api-key': 'secret' } }),
    );
  });

  it('truncates response body at max_response_bytes', async () => {
    const bigBody = 'x'.repeat(2000);
    const fetch = mockFetch(200, bigBody);
    vi.stubGlobal('fetch', fetch);
    const agent = makeAgentConfig({ max_response_bytes: 100 });
    const result = await executeHttp('get', { url: 'https://api.example.com/' }, agent, DEFAULT_SECURITY);
    expect(result.body.length).toBe(100);
    expect(result.truncated).toBe(true);
  });

  it('does not set truncated when body fits', async () => {
    const fetch = mockFetch(200, 'short');
    vi.stubGlobal('fetch', fetch);
    const result = await executeHttp('get', { url: 'https://api.example.com/' }, makeAgentConfig(), DEFAULT_SECURITY);
    expect(result.truncated).toBeFalsy();
  });

  it('returns non-2xx status without throwing', async () => {
    const fetch = mockFetch(404, 'Not Found');
    vi.stubGlobal('fetch', fetch);
    const result = await executeHttp('get', { url: 'https://api.example.com/missing' }, makeAgentConfig(), DEFAULT_SECURITY);
    expect(result.status).toBe(404);
    expect(result.body).toBe('Not Found');
  });

  it('throws on timeout', async () => {
    const fetch = vi.fn().mockImplementation((_url: string, opts: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    vi.stubGlobal('fetch', fetch);
    const agent = makeAgentConfig({ timeout_ms: 50 });
    await expect(
      executeHttp('get', { url: 'https://api.example.com/' }, agent, DEFAULT_SECURITY),
    ).rejects.toThrow(/timed out/);
  });
});
