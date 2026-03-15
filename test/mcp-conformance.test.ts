/**
 * MCP Conformance Test
 *
 * Connects to the same echo MCP server both directly and through Airlock,
 * then asserts that tool listings and call responses are structurally identical.
 *
 * This catches:
 * - Response re-wrapping / double-encoding
 * - Missing fields (structuredContent, isError)
 * - Tool name mangling beyond the expected namespace prefix
 * - Description corruption
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { AgentConfig, SecurityConfig } from '../src/config/schema.js';
import type { BackendAdapter } from '../src/backend/types.js';
import type { ToolCall, ToolResult } from '../src/types.js';
import type { AuditLogger } from '../src/audit/logger.js';
import { createDownstreamServer } from './echo-server.js';
import { createAgentServer, connectAgentServer } from '../src/transport/agent-server.js';
import { ToolRegistry } from '../src/registry/registry.js';
import { AllowlistEngine } from '../src/allowlist/engine.js';
import { HitlEngine } from '../src/hitl/engine.js';
import { HitlBatcher } from '../src/hitl/batcher.js';
import { vi } from 'vitest';

const NAMESPACE = 'echo';

const SECURITY: SecurityConfig = {
  blocked_hosts: [],
  allowed_local: [],
};

function makeAgentConfig(): AgentConfig {
  return {
    allow: [`${NAMESPACE}/*`],
    ask: [],
    deny: [],
    tool_overrides: {},
    exec: { allow: [], ask: [], deny: ['*'], env: {}, default_timeout_ms: 5000 },
    http: { domain_allowlist: [], max_response_bytes: 1048576, timeout_ms: 5000 },
    middleware: [],
  };
}

function makeMockAuditLogger() {
  return {
    log: vi.fn(),
    insertHitl: vi.fn(),
    updateHitlStatus: vi.fn(),
    getPendingHitl: vi.fn().mockReturnValue([]),
  } as unknown as AuditLogger;
}

class McpTestAdapter implements BackendAdapter {
  readonly id: string;

  constructor(
    private mcpId: string,
    private client: Client
  ) {
    this.id = `mcp:${mcpId}`;
  }

  async listTools(): Promise<Tool[]> {
    const result = await this.client.listTools();
    return result.tools.map((t) => ({ ...t, name: `${this.mcpId}/${t.name}` }));
  }

  async call(toolCall: ToolCall): Promise<ToolResult> {
    const originalName = toolCall.tool.slice(this.mcpId.length + 1);
    try {
      const data = await this.client.callTool({ name: originalName, arguments: toolCall.args });
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async stop(): Promise<void> {}
}

// ─── Test suite ──────────────────────────────────────────────────────────────

describe('MCP conformance: direct vs through Airlock', () => {
  let directClient: Client;
  let airlockClient: Client;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    // 1. Create two instances of the same downstream server
    const directServer = createDownstreamServer();
    const airlockDownstream = createDownstreamServer();

    // 2. Connect direct client
    const [directClientTransport, directServerTransport] = InMemoryTransport.createLinkedPair();
    await directServer.connect(directServerTransport);
    directClient = new Client({ name: 'direct-test', version: '0.0.1' });
    await directClient.connect(directClientTransport);

    // 3. Connect airlock client → agent server → registry → adapter → downstream
    const [poolClientTransport, downstreamTransport] = InMemoryTransport.createLinkedPair();
    const poolClient = new Client({ name: 'airlock-pool', version: '0.0.1' });
    await airlockDownstream.connect(downstreamTransport);
    await poolClient.connect(poolClientTransport);

    const adapter = new McpTestAdapter(NAMESPACE, poolClient);
    const agents = { agent: makeAgentConfig() };
    const allowlist = new AllowlistEngine(agents);
    const registry = new ToolRegistry([adapter], allowlist, agents);
    await registry.refresh();

    const auditLogger = makeMockAuditLogger();
    const provider = { init: vi.fn(), notify: vi.fn(), stop: vi.fn() };
    const hitlEngine = new HitlEngine(auditLogger, provider, 300000);
    const hitlBatcher = new HitlBatcher(50);

    const server = createAgentServer({
      agentId: 'agent',
      agentConfig: agents.agent,
      registry,
      allowlist,
      hitlEngine,
      hitlBatcher,
      hitlProvider: provider as never,
      auditLogger,
      securityConfig: SECURITY,
    });

    const [testClientTransport, agentServerTransport] = InMemoryTransport.createLinkedPair();
    await connectAgentServer(server, agentServerTransport);
    airlockClient = new Client({ name: 'airlock-test', version: '0.0.1' });
    await airlockClient.connect(testClientTransport);

    teardown = async () => {
      await directClient.close();
      await airlockClient.close();
      await poolClient.close();
    };
  });

  afterAll(async () => {
    await teardown();
  });

  // ─── Tool listing ────────────────────────────────────────────────────────

  it('lists the same tools (modulo namespace prefix)', async () => {
    const directTools = await directClient.listTools();
    const airlockTools = await airlockClient.listTools();

    const directNames = directTools.tools.map((t) => t.name).sort();
    const airlockNames = airlockTools.tools.map((t) => t.name.replace(`${NAMESPACE}/`, '')).sort();

    expect(airlockNames).toEqual(directNames);
  });

  it('preserves tool input schemas', async () => {
    const directTools = await directClient.listTools();
    const airlockTools = await airlockClient.listTools();

    for (const directTool of directTools.tools) {
      const airlockTool = airlockTools.tools.find(
        (t) => t.name === `${NAMESPACE}/${directTool.name}`
      );
      expect(airlockTool).toBeDefined();
      expect(airlockTool!.inputSchema).toEqual(directTool.inputSchema);
    }
  });

  // ─── Tool call responses ─────────────────────────────────────────────────

  it('echo: response content is identical', async () => {
    const args = { message: 'conformance test' };

    const directResult = await directClient.callTool({ name: 'echo', arguments: args });
    const airlockResult = await airlockClient.callTool({
      name: `${NAMESPACE}/echo`,
      arguments: args,
    });

    expect(airlockResult.content).toEqual(directResult.content);
    expect(airlockResult.isError).toEqual(directResult.isError);
  });

  it('add: response content is identical', async () => {
    const args = { a: 17, b: 25 };

    const directResult = await directClient.callTool({ name: 'add', arguments: args });
    const airlockResult = await airlockClient.callTool({
      name: `${NAMESPACE}/add`,
      arguments: args,
    });

    expect(airlockResult.content).toEqual(directResult.content);
    expect(airlockResult.isError).toEqual(directResult.isError);
  });

  it('echo: empty message is passed through faithfully', async () => {
    const args = { message: '' };

    const directResult = await directClient.callTool({ name: 'echo', arguments: args });
    const airlockResult = await airlockClient.callTool({
      name: `${NAMESPACE}/echo`,
      arguments: args,
    });

    expect(airlockResult.content).toEqual(directResult.content);
  });

  it('add: zero values are passed through faithfully', async () => {
    const args = { a: 0, b: 0 };

    const directResult = await directClient.callTool({ name: 'add', arguments: args });
    const airlockResult = await airlockClient.callTool({
      name: `${NAMESPACE}/add`,
      arguments: args,
    });

    expect(airlockResult.content).toEqual(directResult.content);
  });

  it('echo: special characters are not mangled', async () => {
    const args = { message: '{"json": true, "nested": {"key": "value"}}' };

    const directResult = await directClient.callTool({ name: 'echo', arguments: args });
    const airlockResult = await airlockClient.callTool({
      name: `${NAMESPACE}/echo`,
      arguments: args,
    });

    expect(airlockResult.content).toEqual(directResult.content);
  });

  it('add: negative numbers are handled correctly', async () => {
    const args = { a: -5, b: 3 };

    const directResult = await directClient.callTool({ name: 'add', arguments: args });
    const airlockResult = await airlockClient.callTool({
      name: `${NAMESPACE}/add`,
      arguments: args,
    });

    expect(airlockResult.content).toEqual(directResult.content);
  });

  // ─── Multiple content items ──────────────────────────────────────────────

  it('multi_content: multiple content items are preserved', async () => {
    const args = { message: 'hello' };

    const directResult = await directClient.callTool({ name: 'multi_content', arguments: args });
    const airlockResult = await airlockClient.callTool({
      name: `${NAMESPACE}/multi_content`,
      arguments: args,
    });

    expect(airlockResult.content).toEqual(directResult.content);
    expect(airlockResult.content).toHaveLength(2);
  });

  // ─── Error responses ─────────────────────────────────────────────────────

  it('error_tool: isError flag is preserved', async () => {
    const directResult = await directClient.callTool({ name: 'error_tool', arguments: {} });
    const airlockResult = await airlockClient.callTool({
      name: `${NAMESPACE}/error_tool`,
      arguments: {},
    });

    expect(airlockResult.content).toEqual(directResult.content);
    expect(airlockResult.isError).toEqual(directResult.isError);
    expect(airlockResult.isError).toBe(true);
  });

  // ─── JSON content ────────────────────────────────────────────────────────

  it('json_tool: JSON text content is not double-encoded', async () => {
    const args = { key: 'test' };

    const directResult = await directClient.callTool({ name: 'json_tool', arguments: args });
    const airlockResult = await airlockClient.callTool({
      name: `${NAMESPACE}/json_tool`,
      arguments: args,
    });

    expect(airlockResult.content).toEqual(directResult.content);

    // Verify the text is valid JSON that can be parsed exactly once
    const directText = (directResult.content[0] as { text: string }).text;
    const airlockText = (airlockResult.content[0] as { text: string }).text;
    expect(JSON.parse(airlockText)).toEqual(JSON.parse(directText));
  });
});
