import { randomUUID } from 'crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createAgentServer, connectAgentServer } from './agent-server.js';
import type { AgentServerDeps } from './agent-server.js';
import { childLogger } from '../util/logger.js';
import { checkBearerAuth, checkOrigin, currentRequestSecurity, type RequestSecurityOptions } from '../security/request.js';
import type { SessionLimiter } from './session-limiter.js';

const log = childLogger('http-server');

// eslint-disable-next-line @typescript-eslint/require-await
export async function httpServerPlugin(
  app: FastifyInstance,
  opts: {
    getDeps: (agentId: string) => AgentServerDeps | undefined;
	    secret?: string;
	    authRequired?: boolean;
	    allowedOrigins?: string[];
	    getRequestSecurity?: () => RequestSecurityOptions;
	    sessionLimiter?: SessionLimiter;
	  }
): Promise<void> {
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; ac: AbortController; profileId: string }
  >();

  // Don't parse request bodies — handleRequest reads the raw stream.
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

    const sessionId = request.headers['mcp-session-id'] as string | undefined;
    const limiter = opts.sessionLimiter;

    let transport: StreamableHTTPServerTransport;

    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        // The client is using a session id airlock no longer has — reaped/expired server-side, or
        // lost across a gateway restart — while the client kept using it. Every request then 404s;
        // a client that doesn't re-initialize on 404 appears to hang until it's restarted. Logged
        // at WARN because a run of these is the signature of that wedge (correlate by sessionId).
        log.warn(
          { profileId, sessionId, httpMethod: request.method },
          'MCP request for unknown/expired session (404) — client using a stale session id'
        );
        return reply.status(404).send({ error: `Session not found: ${sessionId}` });
      }
      if (session.profileId !== profileId) {
        return reply.status(403).send({ error: 'Session does not belong to this agent' });
      }
      transport = session.transport;
      limiter?.touch(sessionId);
    } else {
      // New session — enforce per-agent bulkheads BEFORE allocating a transport or upstream server,
      // so a flooding/looping client is rejected at the door instead of piling up resources.
      const admit = limiter?.tryOpen(profileId);
      if (admit && !admit.ok) {
        return reply.status(admit.status).send({ error: admit.message });
      }

      const ac = new AbortController();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, ac, profileId });
          limiter?.register(id, profileId, () => ac.abort());
          log.info({ profileId, sessionId: id }, 'HTTP session initialized');
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
          limiter?.close(id);
          ac.abort();
          log.info({ profileId, sessionId: id }, 'HTTP session closed');
        },
      });

      const server = createAgentServer({
        ...deps,
        getDownstreamSessionId: () => transport.sessionId,
        signal: ac.signal,
      });
      await connectAgentServer(server, transport);

      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) {
          sessions.delete(id);
          limiter?.close(id);
        }
        ac.abort();
      };
    }

    // Hand off raw Node.js req/res — Fastify must not touch the response after this.
    reply.hijack();

    // Transport-level request log, one layer BELOW the tool pipeline's audit trail. A 'request in'
    // with no matching 'request done' (same reqId) is a handleRequest that never returned — the
    // session is wedged at the transport and the tool call never reaches the pipeline (no 'received'
    // audit row), which is exactly what a client that has to be restarted looks like. Two near
    // simultaneous sessionId:'init' entries reveal a client that double-initializes (paired-session
    // churn). Cheap at this traffic; grep by reqId/sessionId during an incident.
    const reqId = randomUUID().slice(0, 8);
    const reqLog = { profileId, reqId, httpMethod: request.method, sessionId: sessionId ?? 'init' };
    const startedAt = Date.now();
    log.info(reqLog, 'MCP transport: request in');

    // Track in-flight so the idle reaper never severs a session that is actively serving a
    // request — including a tool call parked for minutes/hours awaiting HITL approval, whose
    // response stream stays open the entire time. Only meaningful for existing sessions (a new
    // session has no id yet during its initialize handshake, which is short-lived anyway).
    try {
      if (sessionId && limiter) {
        limiter.beginRequest(sessionId);
        try {
          await transport.handleRequest(request.raw, reply.raw);
        } finally {
          limiter.endRequest(sessionId);
        }
      } else {
        await transport.handleRequest(request.raw, reply.raw);
      }
    } finally {
      log.info({ ...reqLog, ms: Date.now() - startedAt }, 'MCP transport: request done');
    }
  }

  app.post('/agents/:profileId/mcp', handleMcpRequest);
  app.get('/agents/:profileId/mcp', handleMcpRequest);
  app.delete('/agents/:profileId/mcp', handleMcpRequest);
}
