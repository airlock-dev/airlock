import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ToolRegistry } from '../registry/registry.js';
import type { AllowlistEngine } from '../allowlist/engine.js';
import type { HitlEngine } from '../hitl/engine.js';
import type { HitlBatcher } from '../hitl/batcher.js';
import type { HitlProvider } from '../hitl/providers/types.js';
import type { AuditLogger } from '../audit/logger.js';
import type { AgentConfig, SecurityConfig } from '../config/schema.js';
import type { Middleware, ToolCallContext } from '../middleware/types.js';
import { buildMiddlewareChain } from '../middleware/chain-builder.js';
import { generateId } from '../util/id.js';
import { VERSION } from '../version.js';

export interface AgentServerDeps {
  agentId: string;
  agentConfig: AgentConfig;
  getAgentConfig?: () => AgentConfig;
  registry: ToolRegistry;
  allowlist: AllowlistEngine;
  hitlEngine: HitlEngine;
  hitlBatcher: HitlBatcher;
  hitlProvider: HitlProvider;
  auditLogger: AuditLogger;
  securityConfig?: SecurityConfig;
  chain?: Middleware;
  /** Signals that the transport/session has been closed. */
  signal?: AbortSignal;
}

export function createAgentServer(deps: AgentServerDeps): Server {
  const { agentId, registry, allowlist, hitlEngine, hitlBatcher, auditLogger } = deps;
  const getConfig = deps.getAgentConfig ?? (() => deps.agentConfig);

  const chain =
    deps.chain ??
    buildMiddlewareChain(getConfig(), {
      registry,
      allowlist,
      hitlEngine,
      hitlBatcher,
      auditLogger,
      securityConfig: deps.securityConfig ?? { blocked_hosts: [], allowed_local: [] },
    });

  const server = new Server({ name: 'airlock', version: VERSION }, { capabilities: { tools: {} } });

  // MCP tool name pattern: ^[a-zA-Z0-9_-]{1,64}$
  // Airlock namespaces tools as "provider/toolName" which contains '/'.
  // Replace '/' with '_' at the protocol boundary so all clients accept the names.
  function sanitize(name: string): string {
    return name.replace(/\//g, '_');
  }

  server.setRequestHandler(ListToolsRequestSchema, () => {
    const tools = registry.getFiltered(agentId);
    return { tools: tools.map((t) => ({ ...t, name: sanitize(t.name) })) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const sanitizedName = request.params.name;
    // Reverse-map sanitized name back to the internal namespaced name so that
    // allowlist patterns ("provider/*") and the registry both work correctly.
    const allTools = registry.getFiltered(agentId);
    const match = allTools.find((t) => sanitize(t.name) === sanitizedName);
    const toolName = match?.name ?? sanitizedName;
    const args = request.params.arguments ?? {};

    const ctx: ToolCallContext = {
      callId: generateId(),
      agentId,
      agentConfig: getConfig(),
      toolName,
      args,
      meta: {},
      deps: {
        registry,
        allowlist,
        hitlEngine,
        hitlBatcher,
        auditLogger,
        securityConfig: deps.securityConfig ?? { blocked_hosts: [], allowed_local: [] },
      },
      startedAt: Date.now(),
      signal: deps.signal,
    };

    const response = await chain(ctx, () => {
      throw new Error('Middleware chain did not terminate — missing execute middleware');
    });

    // Pass through downstream MCP response shape (content, structuredContent, isError)
    // if the result looks like a CallToolResult. Otherwise wrap as text.
    const result = response.result as Record<string, unknown> | undefined;
    if (result && Array.isArray(result.content)) {
      return {
        content: result.content as Array<{ type: string; text: string }>,
        ...(result.structuredContent !== undefined
          ? { structuredContent: result.structuredContent }
          : {}),
        ...(result.isError ? { isError: true } : {}),
      };
    }

    return {
      content: [{ type: 'text', text: response.text }],
    };
  });

  return server;
}

export async function connectAgentServer(server: Server, transport: Transport): Promise<void> {
  await server.connect(transport);
}
