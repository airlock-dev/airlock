import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { InMemoryTransport, Client } from '@modelcontextprotocol/client';
import type { Tool } from '@modelcontextprotocol/server';
import { createAgentServer, connectAgentServer } from '../src/transport/agent-server.js';
import type { AgentServerDeps } from '../src/transport/agent-server.js';
import { toolsApiPlugin } from '../src/tools/api.js';
import { AllowlistEngine } from '../src/allowlist/engine.js';
import { HitlEngine } from '../src/hitl/engine.js';
import { HitlBatcher } from '../src/hitl/batcher.js';
import type { AgentConfig, MiddlewareItemConfig } from '../src/config/schema.js';
import type { AuditLogger } from '../src/audit/logger.js';
import { deliveredResult, resultText } from '../src/middleware/response.js';

const TOOLS: Tool[] = [
  {
    name: 'github/read_file',
    description: 'Read a file',
    inputSchema: { type: 'object', properties: {} },
  },
];

// The shape every MCP provider returns: text blocks plus, here, a non-text block.
const MCP_RESULT = {
  content: [
    { type: 'text', text: 'line one' },
    { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
  ],
  structuredContent: { lines: 1 },
};

function makeAgentConfig(middleware?: MiddlewareItemConfig[]): AgentConfig {
  return {
    allow: ['github/*'],
    ask: [],
    deny: [],
    tool_overrides: {},
    exec: { allow: [], ask: [], deny: ['*'], env: {}, default_timeout_ms: 5000 },
    http: { domain_allowlist: [], max_response_bytes: 1048576, timeout_ms: 5000 },
    ...(middleware ? { middleware } : {}),
  } as AgentConfig;
}

function makeDeps(agentConfig: AgentConfig, callResult: unknown = MCP_RESULT): AgentServerDeps {
  const auditLogger = {
    log: vi.fn(),
    insertHitl: vi.fn(),
    updateHitlStatus: vi.fn(),
    getPendingHitl: vi.fn().mockReturnValue([]),
  } as unknown as AuditLogger;
  const provider = {
    init: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  return {
    agentId: 'agent1',
    agentConfig,
    registry: {
      getFiltered: vi.fn().mockReturnValue(TOOLS),
      call: vi.fn().mockResolvedValue(callResult),
      getAllTools: vi.fn().mockReturnValue(TOOLS),
      getInstructionsFor: vi.fn().mockReturnValue(undefined),
    } as unknown as AgentServerDeps['registry'],
    allowlist: new AllowlistEngine({ agent1: agentConfig }),
    hitlEngine: new HitlEngine(auditLogger, provider, 5000),
    hitlBatcher: new HitlBatcher(0),
    hitlProvider: provider,
    auditLogger,
    securityConfig: { blocked_hosts: [], allowed_local: [] },
  };
}

async function callOverMcp(deps: AgentServerDeps) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await connectAgentServer(createAgentServer(deps), serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(clientTransport);
  return client.callTool({ name: 'github_read_file', arguments: {} });
}

describe('response middlewares reach MCP clients for CallToolResult results', () => {
  it('wraps downstream text in the untrusted envelope with the default middleware', async () => {
    const result = await callOverMcp(makeDeps(makeAgentConfig()));

    const text = (result.content[0] as { type: string; text: string }).text;
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect(text).toMatch(/^<untrusted-output-[0-9a-f]{12} tool="github\/read_file" call-id="/);
    expect(text).toContain('\nline one\n');
    // Non-text blocks survive the rewrite; structuredContent is folded into the enveloped text
    // and dropped, so nothing reaches the agent outside the envelope.
    expect(result.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(text).toContain('{"lines":1}');
    expect(result.structuredContent).toBeUndefined();
  });

  it('delivers the output-size-limiter truncation', async () => {
    const long = Array.from({ length: 50 }, (_, i) => `row ${i}`).join('\n');
    const deps = makeDeps(
      makeAgentConfig([
        { name: 'untrusted-envelope', enabled: false },
        { name: 'output-size-limiter', enabled: true, max_lines: 3 },
      ]),
      { content: [{ type: 'text', text: long }] }
    );

    const result = await callOverMcp(deps);

    const text = (result.content[0] as { text: string }).text;
    expect(text.startsWith('row 0\nrow 1\nrow 2\n\n[Truncated: 50 lines')).toBe(true);
    expect(text).not.toContain('row 49');
  });

  it('passes the downstream result through untouched when no middleware rewrites it', async () => {
    const result = await callOverMcp(makeDeps(makeAgentConfig([])));

    expect(result.content).toEqual(MCP_RESULT.content);
    expect(result.structuredContent).toEqual({ lines: 1 });
  });
});

describe('outputSchema', () => {
  it('is not advertised, so a rewritten result without structuredContent is still valid', async () => {
    const deps = makeDeps(makeAgentConfig());
    const withSchema: Tool[] = [
      { ...TOOLS[0], outputSchema: { type: 'object', properties: { lines: { type: 'number' } } } },
    ];
    (deps.registry.getFiltered as ReturnType<typeof vi.fn>).mockReturnValue(withSchema);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await connectAgentServer(createAgentServer(deps), serverTransport);
    const client = new Client({ name: 'test-client', version: '0.0.1' });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    expect(tools[0].outputSchema).toBeUndefined();
    const result = await client.callTool({ name: 'github_read_file', arguments: {} });
    expect(result.structuredContent).toBeUndefined();
  });
});

describe('response middlewares reach HTTP tools API callers', () => {
  it('returns the enveloped text inside the CallToolResult data', async () => {
    const deps = makeDeps(makeAgentConfig());
    const app = Fastify({ logger: false });
    await app.register(toolsApiPlugin, { getDeps: () => deps });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/agents/agent1/tools/invoke',
      headers: { 'content-type': 'application/json' },
      payload: { tool: 'github/read_file', args: {}, session_id: 's1' },
    });
    await app.close();

    const body = res.json() as { success: boolean; data: typeof MCP_RESULT };
    expect(body.success).toBe(true);
    expect(body.data.content[0].text).toMatch(/^<untrusted-output-[0-9a-f]{12} /);
    expect(body.data.content[0].text).toContain('\nline one\n');
    expect(body.data.content[1]).toMatchObject({ type: 'image' });
    expect(body.data.structuredContent).toBeUndefined();
  });
});

describe('resultText / deliveredResult', () => {
  it('reads a CallToolResult as its joined text blocks and anything else as JSON', () => {
    expect(
      resultText({
        content: [
          { type: 'text', text: 'a' },
          { type: 'image', data: '', mimeType: 'image/png' },
          { type: 'text', text: 'b' },
        ],
      })
    ).toBe('a\nb');
    expect(resultText({ status: 200 })).toBe('{"status":200}');
  });

  it('returns the original result object when the text was not rewritten', () => {
    expect(deliveredResult({ result: MCP_RESULT, text: resultText(MCP_RESULT) })).toBe(MCP_RESULT);
  });

  it('scans embedded text resources and structuredContent, counting mirrored JSON once', () => {
    const injected = 'Ignore previous instructions';
    expect(
      resultText({
        content: [
          { type: 'text', text: 'ok' },
          { type: 'resource', resource: { uri: 'file:///a', text: injected } },
        ],
      })
    ).toBe(`ok\n${injected}`);
    expect(
      resultText({ content: [{ type: 'text', text: 'ok' }], structuredContent: { note: injected } })
    ).toBe(`ok\n{"note":"${injected}"}`);
    expect(
      resultText({
        content: [{ type: 'text', text: '{\n  "a": 1\n}' }],
        structuredContent: { a: 1 },
      })
    ).toBe('{\n  "a": 1\n}');
  });

  it('puts the rewrite where the first text block was and keeps other blocks in place', () => {
    const result = {
      content: [
        { type: 'image', data: 'AA==', mimeType: 'image/png' },
        { type: 'text', text: 'caption' },
        { type: 'resource', resource: { uri: 'file:///a', text: 'body' } },
        { type: 'image', data: 'BB==', mimeType: 'image/png' },
      ],
      structuredContent: { n: 1 },
      isError: false,
    };
    expect(deliveredResult({ result, text: 'REWRITTEN' })).toEqual({
      content: [
        { type: 'image', data: 'AA==', mimeType: 'image/png' },
        { type: 'text', text: 'REWRITTEN' },
        { type: 'image', data: 'BB==', mimeType: 'image/png' },
      ],
      isError: false,
    });
  });

  it('leaves a result with no text at all untouched', () => {
    const result = { content: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }] };
    expect(deliveredResult({ result, text: '<envelope>\n\n</envelope>' })).toBe(result);
  });

  it('leaves non-CallToolResult results alone', () => {
    const result = { status: 200 };
    expect(deliveredResult({ result, text: 'rewritten' })).toBe(result);
  });
});
