import { randomUUID } from 'crypto';
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler, type NodeMcpRequestHandler } from '@modelcontextprotocol/node';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createAgentServer } from './agent-server.js';
import type { AgentServerDeps } from './agent-server.js';
import { childLogger } from '../util/logger.js';
import {
  checkBearerAuth,
  checkOrigin,
  currentRequestSecurity,
  type RequestSecurityOptions,
} from '../security/request.js';

const log = childLogger('http-server');

/**
 * Streamable HTTP data plane, served statelessly.
 *
 * Every request gets a fresh agent server from the factory and nothing survives between requests:
 * 2026-07-28 clients send the per-request `_meta` envelope, and 2025-era clients are answered by the
 * SDK's stateless legacy fallback (no `Mcp-Session-Id` is ever issued; GET/DELETE answer 405). There
 * is therefore no session table to exhaust, reap, or lose across a restart — the failure mode the
 * old per-agent session cap existed to contain.
 *
 * What a session used to give us is now per-request:
 * - disconnect detection: the request's own abort signal (see `anySignal` in agent-server), which
 *   fires when the client cancels or drops the connection a parked HITL call is waiting on;
 * - session-scoped grants: an agent-supplied session id (`_meta["dev.airlock/session"]`, the
 *   `X-Airlock-Session-Id` header, or `?session=`), resolved through `resolveSessionId`.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function httpServerPlugin(
  app: FastifyInstance,
  opts: {
    getDeps: (agentId: string) => AgentServerDeps | undefined;
    /** Map an agent-supplied session id to the opaque downstream session id for that agent. */
    resolveSessionId?: (agentId: string, explicitSessionId: string) => string;
    secret?: string;
    authRequired?: boolean;
    allowedOrigins?: string[];
    getRequestSecurity?: () => RequestSecurityOptions;
  }
): Promise<void> {
  // One SDK handler per agent profile, created on first use. The handler holds no per-client state
  // (only the subscriptions/listen bus), so caching it is safe across config reloads: the factory
  // reads live deps on every request.
  const handlers = new Map<string, { handler: McpHttpHandler; node: NodeMcpRequestHandler }>();

  function handlerFor(profileId: string): NodeMcpRequestHandler {
    const existing = handlers.get(profileId);
    if (existing) return existing.node;

    const handler = createMcpHandler(
      () => {
        const deps = opts.getDeps(profileId);
        // The route checked the profile before dispatching; it can only vanish in a reload race.
        if (!deps) throw new Error(`Unknown agent profile: ${profileId}`);
        const { resolveSessionId } = opts;
        return createAgentServer({
          ...deps,
          ...(resolveSessionId
            ? { resolveSessionId: (id: string) => resolveSessionId(profileId, id) }
            : {}),
        });
      },
      {
        legacy: 'stateless',
        onerror: (err) => log.warn({ profileId, err }, 'MCP handler error'),
      }
    );
    const node = toNodeHandler(handler, {
      onerror: (err) => log.error({ profileId, err }, 'MCP node adapter error'),
    });
    handlers.set(profileId, { handler, node });
    return node;
  }

  app.addHook('onClose', async () => {
    await Promise.allSettled([...handlers.values()].map(({ handler }) => handler.close()));
    handlers.clear();
  });

  // Don't parse request bodies — the SDK handler reads the raw stream.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    '*',
    (_req: FastifyRequest, _payload: unknown, done: (err: null) => void) => {
      done(null);
    }
  );

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

  async function handleMcpRequest(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { profileId } = request.params as { profileId: string };

    const deps = opts.getDeps(profileId);
    if (!deps) {
      return reply.status(404).send({ error: `Unknown agent profile: ${profileId}` });
    }

    if (!checkAgentAuth(request, reply, deps)) return;

    const node = handlerFor(profileId);

    // Hand off raw Node.js req/res — Fastify must not touch the response after this.
    reply.hijack();

    // Transport-level request log, one layer BELOW the tool pipeline's audit trail. A 'request in'
    // with no matching 'request done' (same reqId) is a request that never returned — the tool call
    // never reached the pipeline (no 'received' audit row). The MCP method comes from the
    // 2026-07-28 `Mcp-Method` routing header when the client sends it.
    const reqId = randomUUID().slice(0, 8);
    const mcpMethod = request.headers['mcp-method'];
    const reqLog = {
      profileId,
      reqId,
      httpMethod: request.method,
      ...(typeof mcpMethod === 'string' ? { mcpMethod } : {}),
    };
    const startedAt = Date.now();
    log.info(reqLog, 'MCP transport: request in');
    try {
      await node(request.raw, reply.raw);
    } finally {
      log.info({ ...reqLog, ms: Date.now() - startedAt }, 'MCP transport: request done');
    }
  }

  app.post('/agents/:profileId/mcp', handleMcpRequest);
  app.get('/agents/:profileId/mcp', handleMcpRequest);
  app.delete('/agents/:profileId/mcp', handleMcpRequest);
}
