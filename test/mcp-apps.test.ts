import { describe, it, expect, vi } from 'vitest';
import { InMemoryTransport, Client } from '@modelcontextprotocol/client';
import type { Tool } from '@modelcontextprotocol/client';
import { createAgentServer, connectAgentServer } from '../src/transport/agent-server.js';
import type { AgentServerDeps } from '../src/transport/agent-server.js';
import { AllowlistEngine } from '../src/allowlist/engine.js';
import { HitlEngine } from '../src/hitl/engine.js';
import { HitlBatcher } from '../src/hitl/batcher.js';
import { ToolRegistry } from '../src/registry/registry.js';
import { McpBackendAdapter } from '../src/backend/mcp-adapter.js';
import type { ClientPool } from '../src/pool/pool.js';
import type { AgentConfig } from '../src/config/schema.js';
import type { AuditLogger } from '../src/audit/logger.js';
import {
  UI_EXTENSION_ID,
  UI_MIME_TYPE,
  hostSupportsUi,
  isAppOnlyTool,
  namespaceToolUiMeta,
  namespaceUiUri,
  parseNamespacedUiUri,
  toolUiResourceUri,
} from '../src/mcp-apps/ui.js';

const VIEW_URI = 'ui://weather/dashboard';
const NAMESPACED_VIEW_URI = 'ui://airlock/wx/weather/dashboard';
const VIEW_HTML = '<!doctype html><p>forecast</p>';

const upstreamTools: Tool[] = [
  {
    name: 'forecast',
    description: 'Show the forecast',
    inputSchema: { type: 'object', properties: {} },
    _meta: { ui: { resourceUri: VIEW_URI } },
  },
  {
    name: 'refresh',
    description: 'Refresh the dashboard (view only)',
    inputSchema: { type: 'object', properties: {} },
    _meta: { ui: { resourceUri: VIEW_URI, visibility: ['app'] } },
  },
  {
    name: 'plain',
    description: 'No view',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'secret_view',
    description: 'Denied tool with its own view',
    inputSchema: { type: 'object', properties: {} },
    _meta: { ui: { resourceUri: 'ui://weather/secret' } },
  },
];

function makePool() {
  return {
    isReady: () => true,
    listTools: vi.fn(async () => upstreamTools),
    getInstructions: () => undefined,
    callTool: vi.fn(async () => ({
      content: [{ type: 'text', text: '{"temp":21}' }],
      structuredContent: { temp: 21 },
      _meta: { 'com.example/render': { units: 'C' } },
    })),
    readResource: vi.fn(async (_id: string, uri: string) => ({
      contents: [
        {
          uri,
          mimeType: UI_MIME_TYPE,
          text: VIEW_HTML,
          _meta: { ui: { csp: { connectDomains: ['https://api.weather.example'] } } },
        },
        { uri: 'ui://weather/other', mimeType: UI_MIME_TYPE, text: '<p>smuggled</p>' },
      ],
    })),
  };
}

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    allow: ['wx/forecast', 'wx/refresh', 'wx/plain'],
    ask: [],
    deny: ['wx/secret_view'],
    tool_overrides: {},
    exec: { allow: [], ask: [], deny: ['*'], env: {}, default_timeout_ms: 5000 },
    http: { domain_allowlist: [], max_response_bytes: 1048576, timeout_ms: 5000 },
    // undefined → the default chain, including the untrusted-envelope rewrite.
    middleware: undefined,
    ...overrides,
  } as AgentConfig;
}

async function setup(agentOverrides: Partial<AgentConfig> = {}) {
  const pool = makePool();
  const agentConfig = makeAgentConfig(agentOverrides);
  const allowlist = new AllowlistEngine({ agent1: agentConfig });
  const adapter = new McpBackendAdapter('wx', pool as unknown as ClientPool);
  const registry = new ToolRegistry([adapter], allowlist, { agent1: agentConfig });
  await registry.refresh();

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
  const deps: AgentServerDeps = {
    agentId: 'agent1',
    agentConfig,
    registry,
    allowlist,
    hitlEngine: new HitlEngine(auditLogger, provider, 5000),
    hitlBatcher: new HitlBatcher(100),
    hitlProvider: provider,
    auditLogger,
  };
  return { pool, registry, deps };
}

async function connect(deps: AgentServerDeps, rendersUi: boolean): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await connectAgentServer(createAgentServer(deps), serverTransport);
  const client = new Client(
    { name: 'host', version: '0.0.1' },
    rendersUi
      ? { capabilities: { extensions: { [UI_EXTENSION_ID]: { mimeTypes: [UI_MIME_TYPE] } } } }
      : {}
  );
  await client.connect(clientTransport);
  return client;
}

describe('MCP Apps helpers', () => {
  it('round-trips namespaced view URIs, including awkward provider ids', () => {
    expect(namespaceUiUri('wx', VIEW_URI)).toBe(NAMESPACED_VIEW_URI);
    expect(parseNamespacedUiUri(NAMESPACED_VIEW_URI)).toEqual({
      providerId: 'wx',
      upstreamUri: VIEW_URI,
    });
    const odd = namespaceUiUri('my provider/x', 'ui://a/b?c=1');
    expect(parseNamespacedUiUri(odd)).toEqual({
      providerId: 'my provider/x',
      upstreamUri: 'ui://a/b?c=1',
    });
    expect(parseNamespacedUiUri('ui://weather/dashboard')).toBeUndefined();
    expect(parseNamespacedUiUri('ui://airlock/wx/')).toBeUndefined();
  });

  it('reads the view URI from the nested key or the deprecated flat key, ui:// only', () => {
    expect(toolUiResourceUri({ _meta: { ui: { resourceUri: VIEW_URI } } })).toBe(VIEW_URI);
    expect(toolUiResourceUri({ _meta: { 'ui/resourceUri': VIEW_URI } })).toBe(VIEW_URI);
    expect(toolUiResourceUri({ _meta: { ui: { resourceUri: 'https://x' } } })).toBeUndefined();
    expect(toolUiResourceUri({})).toBeUndefined();
  });

  it('namespaces both forms of the view reference', () => {
    const tool = namespaceToolUiMeta(
      { _meta: { ui: { resourceUri: VIEW_URI, visibility: ['app'] }, 'ui/resourceUri': VIEW_URI } },
      'wx'
    );
    expect(tool._meta).toEqual({
      ui: { resourceUri: NAMESPACED_VIEW_URI, visibility: ['app'] },
      'ui/resourceUri': NAMESPACED_VIEW_URI,
    });
  });

  it('treats visibility as model+app by default', () => {
    expect(isAppOnlyTool({})).toBe(false);
    expect(isAppOnlyTool({ _meta: { ui: { visibility: ['app'] } } })).toBe(true);
    expect(isAppOnlyTool({ _meta: { ui: { visibility: ['model', 'app'] } } })).toBe(false);
  });

  it('detects host support from the request envelope, request _meta or the session', () => {
    const caps = { extensions: { [UI_EXTENSION_ID]: { mimeTypes: [UI_MIME_TYPE] } } };
    const key = 'io.modelcontextprotocol/clientCapabilities';
    expect(hostSupportsUi({ [key]: caps }, undefined, undefined)).toBe(true);
    expect(hostSupportsUi(undefined, { [key]: caps }, undefined)).toBe(true);
    expect(hostSupportsUi(undefined, undefined, caps)).toBe(true);
    expect(hostSupportsUi(undefined, undefined, {})).toBe(false);
    expect(
      hostSupportsUi(undefined, undefined, {
        extensions: { [UI_EXTENSION_ID]: { mimeTypes: ['text/uri-list'] } },
      })
    ).toBe(false);
    expect(hostSupportsUi(undefined, undefined, undefined)).toBeUndefined();
  });
});

describe('MCP Apps through the gateway', () => {
  it('advertises namespaced view URIs and keeps app-only tools for a host that renders views', async () => {
    const { deps } = await setup();
    const client = await connect(deps, true);
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    expect(Object.keys(byName).sort()).toEqual(['wx_forecast', 'wx_plain', 'wx_refresh']);
    expect(byName.wx_forecast._meta).toEqual({ ui: { resourceUri: NAMESPACED_VIEW_URI } });
    expect(byName.wx_refresh._meta).toEqual({
      ui: { resourceUri: NAMESPACED_VIEW_URI, visibility: ['app'] },
    });
  });

  it('hides app-only tools from a host that does not render views', async () => {
    const { deps } = await setup();
    const client = await connect(deps, false);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['wx_forecast', 'wx_plain']);
  });

  it('serves the view from the owning provider, under the namespaced URI', async () => {
    const { deps, pool } = await setup();
    const client = await connect(deps, true);
    const result = await client.readResource({ uri: NAMESPACED_VIEW_URI });

    expect(pool.readResource).toHaveBeenCalledWith('wx', VIEW_URI);
    expect(result.contents).toEqual([
      {
        uri: NAMESPACED_VIEW_URI,
        mimeType: UI_MIME_TYPE,
        text: VIEW_HTML,
        _meta: { ui: { csp: { connectDomains: ['https://api.weather.example'] } } },
      },
    ]);
  });

  it('lists only views referenced by tools the agent can see', async () => {
    const { deps } = await setup();
    const client = await connect(deps, true);
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual([NAMESPACED_VIEW_URI]);
    expect(resources[0].mimeType).toBe(UI_MIME_TYPE);
  });

  it('refuses views of denied tools and URIs no tool references', async () => {
    const { deps, pool } = await setup();
    const client = await connect(deps, true);

    for (const uri of [
      'ui://airlock/wx/weather/secret',
      'ui://airlock/wx/weather/anything',
      'ui://weather/dashboard',
      'file:///etc/passwd',
    ]) {
      await expect(client.readResource({ uri })).rejects.toThrow();
    }
    expect(pool.readResource).not.toHaveBeenCalled();
  });

  it('keeps structuredContent and _meta for a tool with a view, despite the envelope rewrite', async () => {
    const { deps } = await setup();
    const client = await connect(deps, true);
    const result = await client.callTool({ name: 'wx_forecast', arguments: {} });

    expect(result.structuredContent).toEqual({ temp: 21 });
    expect(result._meta).toEqual({ 'com.example/render': { units: 'C' } });
    // The text the model reads is still enveloped.
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toMatch(/^<untrusted-output-/);
  });

  it('still drops structuredContent for a tool without a view when the text was rewritten', async () => {
    const { deps } = await setup();
    const client = await connect(deps, true);
    const result = await client.callTool({ name: 'wx_plain', arguments: {} });
    expect(result.structuredContent).toBeUndefined();
  });

  it('drops structuredContent for a view tool when the host does not render views', async () => {
    const { deps } = await setup();
    const client = await connect(deps, false);
    const result = await client.callTool({ name: 'wx_forecast', arguments: {} });
    expect(result.structuredContent).toBeUndefined();
  });

  it('applies policy to app-only tools like any other call', async () => {
    const { deps, pool } = await setup({
      allow: ['wx/forecast', 'wx/plain'],
      deny: ['wx/refresh'],
    });
    const client = await connect(deps, true);
    await expect(client.callTool({ name: 'wx_refresh', arguments: {} })).rejects.toThrow(
      'Tool not available'
    );
    expect(pool.callTool).not.toHaveBeenCalled();
  });
});
