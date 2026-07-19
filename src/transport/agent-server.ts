import { randomUUID } from 'crypto';
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
import { childLogger } from '../util/logger.js';
import { VERSION } from '../version.js';

const log = childLogger('agent-server');

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
  /** Opaque id propagated to downstream MCPs as params._meta.agentId. */
  downstreamSessionId?: string;
  /** Dynamic variant for transports whose session id is assigned during initialization. */
  getDownstreamSessionId?: () => string | undefined;
  /** Signals that the transport/session has been closed. */
  signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createAgentServer(deps: AgentServerDeps): Server {
  const { agentId, registry, allowlist, hitlEngine, hitlBatcher, auditLogger } = deps;
  const getConfig = deps.getAgentConfig ?? (() => deps.agentConfig);
  const fallbackDownstreamSessionId = randomUUID();

  const staticChain = deps.chain;

  // Server-level instructions are fixed at construction, which is fine: a server instance is created
  // per agent session, so each session picks up the current registry state for that agent.
  //
  // Best-effort: instructions are advisory context, so a failure to build them must never stop an
  // agent from getting a session.
  let instructions: string | undefined;
  try {
    instructions = registry.getInstructionsFor(agentId);
  } catch (err) {
    log.debug({ agentId, err }, 'Failed to build server instructions');
  }

  const server = new Server(
    { name: 'airlock', version: VERSION },
    { capabilities: { tools: {} }, ...(instructions ? { instructions } : {}) }
  );

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
    const requestMeta = isRecord(request.params._meta) ? request.params._meta : {};
    const downstreamSessionId =
      deps.getDownstreamSessionId?.() ?? deps.downstreamSessionId ?? fallbackDownstreamSessionId;

    const agentConfig = getConfig();
    const chain =
      staticChain ??
      buildMiddlewareChain(agentConfig, {
        registry,
        allowlist,
        hitlEngine,
        hitlBatcher,
        auditLogger,
        securityConfig: deps.securityConfig ?? { blocked_hosts: [], allowed_local: [] },
      });

    const ctx: ToolCallContext = {
      callId: generateId(),
      agentId,
      agentConfig,
      toolName,
      args,
      meta: {
        mcpRequestMeta: requestMeta,
        downstreamSessionId,
      },
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

    // Lifecycle audit: the request has entered the pipeline. Emitted BEFORE any middleware so even
    // a call that is denied/parked/hung has a 'received' row; the terminal row shares its request_id.
    ctx.deps.auditLogger.log({
      agent_id: ctx.agentId,
      request_id: ctx.callId,
      tool: ctx.toolName,
      args: JSON.stringify(ctx.args),
      result: 'received',
    });

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
