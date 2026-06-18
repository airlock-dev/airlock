import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createAgentServer, connectAgentServer } from './agent-server.js';
import type { AgentServerDeps } from './agent-server.js';
import { childLogger } from '../util/logger.js';
import { checkBearerAuth, checkOrigin, checkRequestSecurity } from '../security/request.js';

const log = childLogger('sse-server');

/** Interval between SSE keep-alive pings (ms). Keeps connections alive through NAT/firewalls. */
const PING_INTERVAL_MS = 30_000;

// eslint-disable-next-line @typescript-eslint/require-await
export async function sseServerPlugin(
  app: FastifyInstance,
  opts: {
    getDeps: (agentId: string) => AgentServerDeps | undefined;
    secret?: string;
    authRequired?: boolean;
    allowedOrigins?: string[];
  }
): Promise<void> {
  const { secret } = opts;
  const sessions = new Map<string, { transport: SSEServerTransport; profileId: string }>();

  // Don't parse request bodies — handlePostMessage reads the raw stream
  // and fails with "stream encoding should not be set" if Fastify parses first.
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
    if (!checkOrigin(request, reply, opts.allowedOrigins)) return false;

    const token = deps.agentConfig.token;
    if (token) {
      return checkBearerAuth(request, reply, { secret: token, authRequired: true });
    }
    // No per-agent token — fall back to global api_secret
    return checkBearerAuth(request, reply, {
      secret,
      authRequired: opts.authRequired,
    });
  }

  // Auth for non-agent endpoints (management API)
  app.addHook('preHandler', async (request, reply) => {
    const url = request.url;
    // Agent endpoints handle their own auth
    if (url.startsWith('/agents/')) return;
    if (!checkRequestSecurity(request, reply, opts)) {
      return;
    }
  });

  app.get('/agents/:profileId/sse', async (request: FastifyRequest, reply: FastifyReply) => {
    const { profileId } = request.params as { profileId: string };

    const deps = opts.getDeps(profileId);
    if (!deps) {
      return reply.status(404).send({ error: `Unknown agent profile: ${profileId}` });
    }

    if (!checkAgentAuth(request, reply, deps)) return;

    log.info({ profileId }, 'New SSE connection');

    // Prevent Fastify from finalising the response when the handler returns —
    // the SSE connection must stay open until the client disconnects.
    reply.hijack();

    const transport = new SSEServerTransport('/agents/' + profileId + '/messages', reply.raw);
    sessions.set(transport.sessionId, { transport, profileId });

    transport.onclose = () => {
      sessions.delete(transport.sessionId);
      log.info({ profileId, sessionId: transport.sessionId }, 'SSE session closed');
    };

    // Per-session abort controller — signals middlewares (e.g. hitl-gate)
    // that the transport is gone so they don't execute into the void.
    const sessionAc = new AbortController();

    const server = createAgentServer({ ...deps, signal: sessionAc.signal });
    await connectAgentServer(server, transport);

    // Send periodic SSE comments to keep the connection alive through
    // NAT gateways, firewalls, and load balancers that kill idle TCP connections.
    const pingTimer = setInterval(() => {
      reply.raw.write(': ping\n\n');
    }, PING_INTERVAL_MS);
    pingTimer.unref();

    // Clean up when client disconnects — listen on the response socket,
    // not the request, because request 'close' fires immediately on GET
    // once the body is consumed (which is instant for GET requests).
    reply.raw.on('close', () => {
      clearInterval(pingTimer);
      sessionAc.abort();
      sessions.delete(transport.sessionId);
      transport.close().catch(() => {});
    });
  });

  app.post('/agents/:profileId/messages', async (request: FastifyRequest, reply: FastifyReply) => {
    const { profileId } = request.params as { profileId: string };
    const { sessionId } = request.query as { sessionId?: string };

    if (!sessionId) {
      return reply.status(400).send({ error: 'sessionId query param required' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
      return reply.status(404).send({ error: `Session not found: ${sessionId}` });
    }

    // Verify the session belongs to the profile in the URL
    if (session.profileId !== profileId) {
      return reply.status(403).send({ error: 'Session does not belong to this agent' });
    }

    // Check auth on message posts too
    const deps = opts.getDeps(profileId);
    if (!deps || !checkAgentAuth(request, reply, deps)) return;

    await session.transport.handlePostMessage(request.raw, reply.raw);
  });
}
