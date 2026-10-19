import { Server } from '@modelcontextprotocol/server';
import type { ContentBlock, Notification, Transport } from '@modelcontextprotocol/server';
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
import { sanitizeToolName } from '../util/tool-name.js';
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
  /**
   * Maps an agent-supplied session id (see {@link explicitSessionId}) to the opaque downstream
   * session id. Lets several agents sharing one profile keep session-scoped grants apart over a
   * stateless transport, where there is no MCP session to key on.
   */
  resolveSessionId?: (explicitSessionId: string) => string;
  /** Signals that the transport/session has been closed. */
  signal?: AbortSignal;
}

/** Per-request `_meta` key an agent can set to identify its session to Airlock. */
export const SESSION_META_KEY = 'dev.airlock/session';
/** Header equivalent of {@link SESSION_META_KEY}, shared with the HTTP tools API. */
export const SESSION_HEADER = 'x-airlock-session-id';
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/;

/**
 * The agent-supplied session id for one tool call: `_meta["dev.airlock/session"]`, then the
 * `X-Airlock-Session-Id` header, then a `?session=` query parameter. The header/query forms exist
 * for clients (Codex, Hermes, Claude Code) that can set static per-server headers or URLs but not
 * per-request `_meta`. Malformed values are ignored rather than trusted.
 */
export function explicitSessionId(
  requestMeta: Record<string, unknown>,
  httpRequest?: Request
): string | undefined {
  const candidates: unknown[] = [requestMeta[SESSION_META_KEY]];
  if (httpRequest) {
    candidates.push(httpRequest.headers.get(SESSION_HEADER));
    try {
      candidates.push(new URL(httpRequest.url).searchParams.get('session'));
    } catch {
      // Relative or unparsable URL — no query to read.
    }
  }
  for (const value of candidates) {
    if (typeof value === 'string' && SESSION_ID_PATTERN.test(value)) return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createAgentServer(deps: AgentServerDeps): Server {
  const { agentId, registry, allowlist, hitlEngine, hitlBatcher, auditLogger } = deps;
  const getConfig = deps.getAgentConfig ?? (() => deps.agentConfig);

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

  server.setRequestHandler('tools/list', () => {
    const tools = registry.getFiltered(agentId);
    return { tools: tools.map((t) => ({ ...t, name: sanitizeToolName(t.name) })) };
  });

  server.setRequestHandler('tools/call', async (request, reqCtx) => {
    const sanitizedName = request.params.name;
    // Reverse-map sanitized name back to the internal namespaced name so that
    // allowlist patterns ("provider/*") and the registry both work correctly.
    const allTools = registry.getFiltered(agentId);
    const match = allTools.find((t) => sanitizeToolName(t.name) === sanitizedName);
    const toolName = match?.name ?? sanitizedName;
    const args = request.params.arguments ?? {};
    const requestMeta = isRecord(request.params._meta) ? request.params._meta : {};
    // No fallback id: over a stateless transport a per-instance random id would change on every
    // request, and a session-only grant bound to it would silently never match again. Without an
    // id the HITL engine refuses session-only grants instead.
    const explicit = deps.resolveSessionId
      ? explicitSessionId(requestMeta, reqCtx.http?.req)
      : undefined;
    const downstreamSessionId =
      (explicit !== undefined ? deps.resolveSessionId?.(explicit) : undefined) ??
      deps.getDownstreamSessionId?.() ??
      deps.downstreamSessionId;

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
        ...(downstreamSessionId !== undefined ? { downstreamSessionId } : {}),
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
      signal: anySignal(deps.signal, reqCtx.mcpReq.signal),
      ...progressSender(requestMeta, reqCtx.mcpReq.notify),
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
        content: result.content as ContentBlock[],
        ...(result.structuredContent !== undefined
          ? { structuredContent: result.structuredContent as Record<string, unknown> }
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

/**
 * When the client asked for progress (params._meta.progressToken), give the pipeline a way to send
 * it. The HITL gate uses this to keep a call that is parked on approval alive in clients that reset
 * their request timeout on progress.
 */
function progressSender(
  requestMeta: Record<string, unknown>,
  sendNotification: (notification: Notification) => Promise<void>
): { sendProgress?: (progress: number, message: string) => void } {
  const progressToken = requestMeta.progressToken;
  if (typeof progressToken !== 'string' && typeof progressToken !== 'number') return {};
  return {
    sendProgress: (progress, message) => {
      void sendNotification({
        method: 'notifications/progress',
        params: { progressToken, progress, message },
      }).catch(() => {});
    },
  };
}

/**
 * Combine the session/transport signal with the per-request one. Over a stateless transport the
 * request signal is the only disconnect signal: it aborts when the client cancels or drops the
 * connection, which is what lets a call parked on HITL approval be cancelled.
 */
function anySignal(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  if (present.length <= 1) return present[0];
  return AbortSignal.any(present);
}

export async function connectAgentServer(server: Server, transport: Transport): Promise<void> {
  await server.connect(transport);
}
