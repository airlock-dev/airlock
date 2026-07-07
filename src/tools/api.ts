import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AgentServerDeps } from '../transport/agent-server.js';
import type { ToolCallContext } from '../middleware/types.js';
import { buildMiddlewareChain } from '../middleware/chain-builder.js';
import { generateId } from '../util/id.js';
import { childLogger } from '../util/logger.js';
import { checkBearerAuth, checkOrigin, currentRequestSecurity, type RequestSecurityOptions } from '../security/request.js';

const log = childLogger('tools-api');

export interface ToolsApiOpts {
  getDeps: (agentId: string, downstreamSessionKey?: string) => AgentServerDeps | undefined;
  requiresSessionId?: (agentId: string, tool: string) => boolean;
  // Per-agent gate for the HTTP tools API. When provided and it returns false for an agent,
  // that agent's routes 404 exactly like an unknown agent — no hint that the agent exists.
  isAgentEnabled?: (agentId: string) => boolean;
  secret?: string;
  authRequired?: boolean;
  allowedOrigins?: string[];
  getRequestSecurity?: () => RequestSecurityOptions;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// eslint-disable-next-line @typescript-eslint/require-await
export async function toolsApiPlugin(app: FastifyInstance, opts: ToolsApiOpts): Promise<void> {
  const { getDeps } = opts;

  function downstreamSessionKey(agentId: string, explicitSessionId: unknown): string | undefined {
    if (!nonEmptyString(explicitSessionId)) return undefined;
    return `${agentId}:${explicitSessionId}`;
  }

  function checkAgentAuth(
    request: FastifyRequest,
    reply: FastifyReply,
    deps: AgentServerDeps
  ): boolean {
    const requestSecurity = currentRequestSecurity(opts);
    if (!checkOrigin(request, reply, requestSecurity.allowedOrigins)) return false;

    const token = deps.agentConfig.token;
    if (token) {
      return checkBearerAuth(request, reply, { secret: token, authRequired: true });
    }
    return checkBearerAuth(request, reply, {
      secret: requestSecurity.secret,
      authRequired: requestSecurity.authRequired,
    });
  }

  app.get('/agents/:agentId/tools', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const deps = getDeps(agentId);
    if (!deps || (opts.isAgentEnabled && !opts.isAgentEnabled(agentId))) {
      return reply.status(404).send({ error: `Unknown agent: ${agentId}` });
    }
    if (!checkAgentAuth(request, reply, deps)) return;

    const tools = deps.registry.getFiltered(agentId);
    return reply.send({ tools });
  });

  app.post('/agents/:agentId/tools/invoke', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const body = request.body as
      | { tool?: string; args?: Record<string, unknown>; session_id?: string }
      | undefined;

    if (!body?.tool) {
      return reply.status(400).send({ error: 'Missing required field: tool' });
    }

    const { tool, args = {} } = body;
    if (!isRecord(args)) {
      return reply.status(400).send({ error: 'Field "args" must be a JSON object' });
    }

    const headerSessionId = request.headers['x-airlock-session-id'];
    const explicitSessionId =
      body.session_id ?? (Array.isArray(headerSessionId) ? headerSessionId[0] : headerSessionId);
    const sessionKey = downstreamSessionKey(agentId, explicitSessionId);
    const authDeps = getDeps(agentId);
    if (!authDeps || (opts.isAgentEnabled && !opts.isAgentEnabled(agentId))) {
      return reply.status(404).send({ error: `Unknown agent: ${agentId}` });
    }
    if (!checkAgentAuth(request, reply, authDeps)) return;

    const deps = getDeps(agentId, sessionKey);
    if (!deps) {
      return reply.status(404).send({ error: `Unknown agent: ${agentId}` });
    }
    if (!sessionKey) {
      if (opts.requiresSessionId?.(agentId, tool)) {
        return reply.status(400).send({
          error:
            'Missing required field: session_id. REST invocations of downstream MCP tools require a stable session_id; pass session_id in the JSON body or X-Airlock-Session-Id header.',
        });
      }
      log.warn(
        { agentId, tool },
        'REST tool invocation missing session_id; downstream MCP freshness identity will not be stamped'
      );
    }

    const getConfig = deps.getAgentConfig ?? (() => deps.agentConfig);
    const agentConfig = getConfig();
    const ac = new AbortController();
    const abort = () => ac.abort();
    request.raw.once('aborted', abort);
    reply.raw.once('close', abort);

    const chain = buildMiddlewareChain(agentConfig, {
      registry: deps.registry,
      allowlist: deps.allowlist,
      hitlEngine: deps.hitlEngine,
      hitlBatcher: deps.hitlBatcher,
      auditLogger: deps.auditLogger,
      securityConfig: deps.securityConfig ?? { blocked_hosts: [], allowed_local: [] },
    });
    const downstreamSessionId = deps.downstreamSessionId ?? sessionKey;

    const ctx: ToolCallContext = {
      callId: generateId(),
      agentId,
      agentConfig,
      toolName: tool,
      args,
      meta: downstreamSessionId ? { downstreamSessionId } : {},
      deps: {
        registry: deps.registry,
        allowlist: deps.allowlist,
        hitlEngine: deps.hitlEngine,
        hitlBatcher: deps.hitlBatcher,
        auditLogger: deps.auditLogger,
        securityConfig: deps.securityConfig ?? { blocked_hosts: [], allowed_local: [] },
      },
      startedAt: Date.now(),
      signal: ac.signal,
    };

    // Lifecycle audit: request entered the pipeline (see agent-server for the rationale).
    ctx.deps.auditLogger.log({
      agent_id: ctx.agentId,
      request_id: ctx.callId,
      tool: ctx.toolName,
      args: JSON.stringify(ctx.args),
      result: 'received',
    });

    try {
      const response = await chain(ctx, () => {
        throw new Error('Middleware chain did not terminate — missing execute middleware');
      });
      const duration_ms = Date.now() - ctx.startedAt;

      // Middleware may return an MCP-style error response (e.g. HITL deny/timeout)
      // with isError: true in the result — map that to success: false for the HTTP API.
      const result = response.result as Record<string, unknown> | undefined;
      if (result?.isError) {
        return reply.send({
          success: false,
          error: response.text || 'Tool call failed',
          metadata: { duration_ms },
        });
      }

      return reply.send({
        success: true,
        data: response.result,
        metadata: { duration_ms, truncated: response.truncated ?? false },
      });
    } catch (err) {
      const duration_ms = Date.now() - ctx.startedAt;
      log.warn({ err, agentId, tool }, 'Tool invocation failed');
      return reply.send({
        success: false,
        error: err instanceof Error ? err.message : String(err),
        metadata: { duration_ms },
      });
    } finally {
      request.raw.off('aborted', abort);
      reply.raw.off('close', abort);
    }
  });
}
