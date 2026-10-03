import { randomUUID } from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type CallToolResult,
  type ContentBlock,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { sanitizeAgentToolName, type ToolRegistry } from '../registry/registry.js';
import type { AllowlistEngine } from '../allowlist/engine.js';
import type { HitlEngine } from '../hitl/engine.js';
import type { HitlBatcher } from '../hitl/batcher.js';
import type { HitlProvider } from '../hitl/providers/types.js';
import type { AuditLogger } from '../audit/logger.js';
import type { AgentConfig, SecurityConfig } from '../config/schema.js';
import type { Middleware, ToolCallContext, ToolCallResponse } from '../middleware/types.js';
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

function isTextContent(value: unknown): value is { type: 'text'; text: string } {
  return isRecord(value) && value.type === 'text' && typeof value.text === 'string';
}

function isEmbeddedResource(value: unknown): boolean {
  return isRecord(value) && value.type === 'resource';
}

function isBinaryContent(value: unknown): boolean {
  return isRecord(value) && (value.type === 'image' || value.type === 'audio');
}

function combinedSignal(
  requestSignal: AbortSignal,
  sessionSignal?: AbortSignal
): { signal: AbortSignal; dispose: () => void } {
  if (!sessionSignal) return { signal: requestSignal, dispose: () => {} };

  const controller = new AbortController();
  const abortFrom = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  const onRequestAbort = () => abortFrom(requestSignal);
  const onSessionAbort = () => abortFrom(sessionSignal);

  if (requestSignal.aborted) {
    abortFrom(requestSignal);
  } else if (sessionSignal.aborted) {
    abortFrom(sessionSignal);
  } else {
    requestSignal.addEventListener('abort', onRequestAbort, { once: true });
    sessionSignal.addEventListener('abort', onSessionAbort, { once: true });
  }

  return {
    signal: controller.signal,
    dispose: () => {
      requestSignal.removeEventListener('abort', onRequestAbort);
      sessionSignal.removeEventListener('abort', onSessionAbort);
    },
  };
}

/**
 * Output middleware operates on the response's flattened text representation. When it changes
 * that text, update only the textual MCP content while retaining non-text content blocks.
 */
function applyTransformedText(
  content: unknown[],
  text: string,
  preserveOriginalPayload: boolean
): ContentBlock[] {
  let replaced = false;
  const transformed: unknown[] = [];

  for (const block of content) {
    if (isTextContent(block)) {
      if (!replaced) {
        transformed.push({ ...block, text });
        replaced = true;
      }
      continue;
    }
    // Resource content can carry arbitrary untrusted text or blobs; it is already represented in
    // the flattened response text, so avoid retaining a second unfiltered copy after transforms.
    if (isEmbeddedResource(block)) continue;
    // Destructive transforms must not let resource links or other textual blocks bypass the
    // transform. Binary image/audio blocks remain valid MCP content and are safe to retain.
    if (!preserveOriginalPayload && !isBinaryContent(block)) continue;
    transformed.push(block);
  }

  if (!replaced) transformed.unshift({ type: 'text', text });
  return transformed as ContentBlock[];
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
    {
      capabilities: { tools: { listChanged: true } },
      ...(instructions ? { instructions } : {}),
      debouncedNotificationMethods: ['notifications/tools/list_changed'],
    }
  );
  const unsubscribeToolsChanged = registry.onToolsChanged(() => {
    void server.sendToolListChanged().catch(() => {
      // A registry can refresh before this agent session connects or while it is closing.
    });
  });
  server.onclose = unsubscribeToolsChanged;

  server.setRequestHandler(ListToolsRequestSchema, () => {
    const tools = registry.getFiltered(agentId);
    return { tools: tools.map((t) => ({ ...t, name: sanitizeAgentToolName(t.name) })) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const sanitizedName = request.params.name;
    // Reverse-map sanitized name back to the internal namespaced name so that
    // allowlist patterns ("provider/*") and the registry both work correctly.
    const allTools = registry.getFiltered(agentId);
    const match = allTools.find((t) => sanitizeAgentToolName(t.name) === sanitizedName);
    const toolName = match?.name ?? sanitizedName;
    const args = request.params.arguments ?? {};
    const requestMeta = isRecord(request.params._meta) ? request.params._meta : {};
    const progressToken = requestMeta.progressToken;
    const requestSignal = combinedSignal(extra.signal, deps.signal);
    const requestOptions = {
      signal: requestSignal.signal,
      ...(typeof progressToken === 'string' || typeof progressToken === 'number'
        ? {
            onprogress: (progress: { progress: number; total?: number; message?: string }) => {
              void extra
                .sendNotification({
                  method: 'notifications/progress',
                  params: { progressToken, ...progress },
                })
                .catch(() => {
                  // The initiating request may have been cancelled while progress was in flight.
                });
            },
          }
        : {}),
    };
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
      requestOptions,
      deps: {
        registry,
        allowlist,
        hitlEngine,
        hitlBatcher,
        auditLogger,
        securityConfig: deps.securityConfig ?? { blocked_hosts: [], allowed_local: [] },
      },
      startedAt: Date.now(),
      signal: requestOptions.signal,
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

    let response: ToolCallResponse;
    try {
      response = await chain(ctx, () => {
        throw new Error('Middleware chain did not terminate — missing execute middleware');
      });
    } finally {
      requestSignal.dispose();
    }

    // Pass through downstream MCP response shape (content, structuredContent, isError, _meta)
    // if the result looks like a CallToolResult. Otherwise wrap as text. Post middleware mutates
    // response.text, so reflect that mutation in textual MCP content while retaining only content
    // blocks that cannot bypass a destructive transform.
    const result = isRecord(response.result) ? response.result : undefined;
    if (result && Array.isArray(result.content)) {
      const serializedResult = JSON.stringify(result);
      const textWasTransformed = response.text !== serializedResult;
      // Envelope/canary middleware preserves the complete original payload inside its wrapper.
      // Destructive middleware (mangling, truncation, summarization) does not, so fail closed by
      // withholding structured content and embedded resource text that would bypass the transform.
      const preserveOriginalPayload =
        !textWasTransformed || response.text.includes(serializedResult);
      const content = (
        !textWasTransformed
          ? result.content
          : applyTransformedText(result.content, response.text, preserveOriginalPayload)
      ) as CallToolResult['content'];

      return {
        content,
        ...(preserveOriginalPayload && result.structuredContent !== undefined
          ? { structuredContent: result.structuredContent as CallToolResult['structuredContent'] }
          : {}),
        ...(typeof result.isError === 'boolean' ||
        (!preserveOriginalPayload && result.structuredContent !== undefined)
          ? {
              isError:
                !preserveOriginalPayload && result.structuredContent !== undefined
                  ? true
                  : result.isError,
            }
          : {}),
        ...(isRecord(result._meta) ? { _meta: result._meta } : {}),
      } as CallToolResult;
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
