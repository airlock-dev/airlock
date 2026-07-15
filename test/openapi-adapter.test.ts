import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { lookup } from 'dns/promises';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { OpenApiAdapter } from '../src/backend/openapi/adapter.js';
import type { ApiConfig, SecurityConfig } from '../src/config/schema.js';

vi.mock('dns/promises', () => ({ lookup: vi.fn() }));

const lookupMock = vi.mocked(lookup);

const PETSTORE_SPEC = {
  openapi: '3.0.3',
  info: { title: 'Petstore', version: '1.0.0' },
  servers: [{ url: 'https://petstore.example.com/v1' }],
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets',
        summary: 'List all pets',
        parameters: [
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer' },
            description: 'Max results',
          },
        ],
        responses: { '200': { description: 'OK' } },
      },
      post: {
        operationId: 'createPet',
        summary: 'Create a pet',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  tag: { type: 'string' },
                },
                required: ['name'],
              },
            },
          },
        },
        responses: { '201': { description: 'Created' } },
      },
    },
    '/pets/{petId}': {
      get: {
        operationId: 'getPet',
        summary: 'Get a pet by ID',
        parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' } },
      },
    },
  },
};

const DEFAULT_SECURITY: SecurityConfig = {
  blocked_hosts: ['localhost', '127.0.0.1'],
  allowed_local: [],
};

function makeConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    spec: '',
    timeout_ms: 30000,
    max_response_bytes: 1048576,
    ...overrides,
  };
}

describe('OpenApiAdapter', () => {
  let dir: string;
  let specPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'openapi-adapter-test-'));
    specPath = join(dir, 'spec.json');
    writeFileSync(specPath, JSON.stringify(PETSTORE_SPEC));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    lookupMock.mockResolvedValue([{ address: '203.0.113.10', family: 4 }] as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    lookupMock.mockReset();
  });

  it('lists tools with namespaced names', async () => {
    const adapter = new OpenApiAdapter(
      'petstore',
      makeConfig({ spec: specPath }),
      DEFAULT_SECURITY
    );
    const tools = await adapter.listTools();

    const names = tools.map((t) => t.name);
    expect(names).toContain('petstore/listPets');
    expect(names).toContain('petstore/createPet');
    expect(names).toContain('petstore/getPet');
  });

  it('returns error for unknown operation', async () => {
    const adapter = new OpenApiAdapter(
      'petstore',
      makeConfig({ spec: specPath }),
      DEFAULT_SECURITY
    );
    await adapter.listTools();

    const result = await adapter.call({
      tool: 'petstore/nonexistent',
      args: {},
      agentId: 'a1',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown operation');
  });

  it('builds URL with path params', async () => {
    const adapter = new OpenApiAdapter(
      'petstore',
      makeConfig({ spec: specPath }),
      DEFAULT_SECURITY
    );
    await adapter.listTools();

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ id: '123', name: 'Fido' }), { status: 200 })
      );

    await adapter.call({
      tool: 'petstore/getPet',
      args: { petId: 'abc-123' },
      agentId: 'a1',
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toBe('https://petstore.example.com/v1/pets/abc-123');
  });

  it('rejects complex path parameters instead of using default object stringification', async () => {
    const adapter = new OpenApiAdapter(
      'petstore',
      makeConfig({ spec: specPath }),
      DEFAULT_SECURITY
    );
    await adapter.listTools();

    const result = await adapter.call({
      tool: 'petstore/getPet',
      args: { petId: { unsafe: true } },
      agentId: 'a1',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Parameter "petId" must be a scalar or an array of scalars');
  });

  it('builds URL with query params', async () => {
    const adapter = new OpenApiAdapter(
      'petstore',
      makeConfig({ spec: specPath }),
      DEFAULT_SECURITY
    );
    await adapter.listTools();

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));

    await adapter.call({
      tool: 'petstore/listPets',
      args: { limit: 10 },
      agentId: 'a1',
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toBe('https://petstore.example.com/v1/pets?limit=10');
  });

  it('sends request body for POST, excluding path/query params', async () => {
    const adapter = new OpenApiAdapter(
      'petstore',
      makeConfig({ spec: specPath }),
      DEFAULT_SECURITY
    );
    await adapter.listTools();

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ id: '1', name: 'Fido' }), { status: 201 }));

    await adapter.call({
      tool: 'petstore/createPet',
      args: { name: 'Fido', tag: 'dog' },
      agentId: 'a1',
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const opts = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body as string)).toEqual({ name: 'Fido', tag: 'dog' });
  });

  it('does not follow redirects automatically', async () => {
    const adapter = new OpenApiAdapter(
      'petstore',
      makeConfig({ spec: specPath }),
      DEFAULT_SECURITY
    );
    await adapter.listTools();

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('', { status: 302, headers: { location: 'http://127.0.0.1/admin' } })
      );

    await adapter.call({
      tool: 'petstore/listPets',
      args: {},
      agentId: 'a1',
    });

    const opts = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(opts.redirect).toBe('manual');
  });

  it('returns error for missing path param', async () => {
    const adapter = new OpenApiAdapter(
      'petstore',
      makeConfig({ spec: specPath }),
      DEFAULT_SECURITY
    );
    await adapter.listTools();

    const result = await adapter.call({
      tool: 'petstore/getPet',
      args: {},
      agentId: 'a1',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing required path parameter');
  });

  it('blocks requests to blocked hosts', async () => {
    const blockedSpec = {
      openapi: '3.0.3',
      info: { title: 'Local', version: '1.0.0' },
      servers: [{ url: 'http://localhost:8080' }],
      paths: {
        '/data': {
          get: {
            operationId: 'getData',
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const blockedSpecPath = join(dir, 'blocked-spec.json');
    writeFileSync(blockedSpecPath, JSON.stringify(blockedSpec));

    const adapter = new OpenApiAdapter(
      'local',
      makeConfig({ spec: blockedSpecPath }),
      DEFAULT_SECURITY
    );
    await adapter.listTools();

    const result = await adapter.call({
      tool: 'local/getData',
      args: {},
      agentId: 'a1',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Blocked host');
  });

  it('blocks configured API hosts that resolve to blocked addresses', async () => {
    lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as any);
    const adapter = new OpenApiAdapter(
      'petstore',
      makeConfig({ spec: specPath }),
      DEFAULT_SECURITY
    );
    await adapter.listTools();

    const result = await adapter.call({
      tool: 'petstore/listPets',
      args: {},
      agentId: 'a1',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('resolved to 127.0.0.1');
  });

  it('fails closed when API host DNS verification fails', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const adapter = new OpenApiAdapter(
      'petstore',
      makeConfig({ spec: specPath }),
      DEFAULT_SECURITY
    );
    await adapter.listTools();

    const result = await adapter.call({
      tool: 'petstore/listPets',
      args: {},
      agentId: 'a1',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Could not verify host: petstore.example.com');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('adds bearer auth header', async () => {
    const adapter = new OpenApiAdapter(
      'petstore',
      makeConfig({ spec: specPath, auth: { type: 'bearer', token: 'secret-token' } }),
      DEFAULT_SECURITY
    );
    await adapter.listTools();

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));

    await adapter.call({
      tool: 'petstore/listPets',
      args: {},
      agentId: 'a1',
    });

    const opts = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = opts.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer secret-token');
  });

  it('adds custom header auth', async () => {
    const adapter = new OpenApiAdapter(
      'petstore',
      makeConfig({ spec: specPath, auth: { type: 'header', name: 'X-API-Key', value: 'key123' } }),
      DEFAULT_SECURITY
    );
    await adapter.listTools();

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));

    await adapter.call({
      tool: 'petstore/listPets',
      args: {},
      agentId: 'a1',
    });

    const opts = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = opts.headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('key123');
  });

  it('returns error on non-ok response', async () => {
    const adapter = new OpenApiAdapter(
      'petstore',
      makeConfig({ spec: specPath }),
      DEFAULT_SECURITY
    );
    await adapter.listTools();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Not Found', { status: 404 }));

    const result = await adapter.call({
      tool: 'petstore/listPets',
      args: {},
      agentId: 'a1',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('HTTP 404');
  });

  it('truncates large responses', async () => {
    const adapter = new OpenApiAdapter(
      'petstore',
      makeConfig({ spec: specPath, max_response_bytes: 10 }),
      DEFAULT_SECURITY
    );
    await adapter.listTools();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('A'.repeat(100), { status: 200 }));

    const result = await adapter.call({
      tool: 'petstore/listPets',
      args: {},
      agentId: 'a1',
    });

    expect(result.success).toBe(true);
    expect(result.metadata?.truncated).toBe(true);
    const body = (result.data as { body: string }).body;
    expect(body.length).toBeLessThanOrEqual(10);
  });

  it('encodes path params', async () => {
    const adapter = new OpenApiAdapter(
      'petstore',
      makeConfig({ spec: specPath }),
      DEFAULT_SECURITY
    );
    await adapter.listTools();

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    await adapter.call({
      tool: 'petstore/getPet',
      args: { petId: 'hello world/foo' },
      agentId: 'a1',
    });

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain('hello%20world%2Ffoo');
  });

  it('uses base_url override from config', async () => {
    const adapter = new OpenApiAdapter(
      'petstore',
      makeConfig({ spec: specPath, base_url: 'https://override.example.com' }),
      DEFAULT_SECURITY
    );
    await adapter.listTools();

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));

    await adapter.call({
      tool: 'petstore/listPets',
      args: {},
      agentId: 'a1',
    });

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url.startsWith('https://override.example.com/')).toBe(true);
  });
});
