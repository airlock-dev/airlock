import { randomUUID } from 'crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { EmptyResultSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createAgentServer, connectAgentServer } from './agent-server.js';
import type { AgentServerDeps } from './agent-server.js';
import { childLogger } from '../util/logger.js';
import {
  checkBearerAuth,
  checkOrigin,
  currentRequestSecurity,
  type RequestSecurityOptions,
} from '../security/request.js';
import type { SessionLimiter } from './session-limiter.js';
import { createStatelessHttpHandler } from './stateless-http-server.js';

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
    /** Probe idle clients over MCP, including through proxies. Injectable for integration tests. */
    heartbeatIntervalMs?: number;
  }
): Promise<void> {
  const sessionless = createStatelessHttpHandler(opts);
  app.addHook('onClose', sessionless.close);
  const sessions = new Map<
    string,
    {
      transport: StreamableHTTPServerTransport;
      server: ReturnType<typeof createAgentServer>;
      ac: AbortController;
      profileId: string;
      probing: boolean;
      eventStreams: number;
      heartbeat?: ReturnType<typeof setTimeout>;
    }
  >();

  // An open event stream is not proof that the client is alive (a proxy may keep its
  // connection open), but a successful MCP ping round trip is. Keep responsive clients
  // alive during long coding/thinking pauses without pinning abandoned sessions forever.
  function scheduleHeartbeat(id: string): void {
    const session = sessions.get(id);
    const limiter = opts.sessionLimiter;
    if (
      !session ||
      !limiter ||
      session.ac.signal.aborted ||
      session.eventStreams === 0 ||
      session.probing ||
      session.heartbeat
    )
      return;
    // Leave time for both the probe and its response before the effective per-agent idle limit.
    // Re-read limits each round so configuration reloads also affect subsequent probes.
    const idleMs = limiter.getSessionIdleMs(session.profileId);
    const budgetMs = idleMs > 0 ? Math.max(1, Math.floor(idleMs / 3)) : Infinity;
    const intervalMs = Math.min(opts.heartbeatIntervalMs ?? 60_000, budgetMs);
    session.heartbeat = setTimeout(() => {
      session.heartbeat = undefined;
      session.probing = true;
      void session.server
        .request({ method: 'ping' }, EmptyResultSchema, {
          timeout: Math.min(5000, budgetMs),
          signal: session.ac.signal,
        })
        .then(() => limiter.touch(id))
        .catch(() => {
          // A missing/half-dead event stream must not refresh the idle clock.
        })
        .finally(() => {
          session.probing = false;
          scheduleHeartbeat(id);
        });
    }, intervalMs);
    session.heartbeat.unref();
  }

  app.addHook('onClose', () => {
    for (const session of sessions.values()) session.ac.abort();
  });

  // Parse JSON once to distinguish legacy initialization from a sessionless request. Both SDK
  // adapters accept the parsed body. Bound this buffering to 4 MiB.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string', bodyLimit: 4 * 1024 * 1024 },
    app.getDefaultJsonParser('error', 'error')
  );
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

    // Legacy initialize still creates a session with heartbeats and session-bound grants.
    // Modern clients (including server/discover) and legacy clients that omit the session ID
    // need a per-request server: creating an uninitialized v1 transport here wedges every call.
    if (!sessionId && (request.method !== 'POST' || !isInitializeRequest(request.body))) {
      const admit = limiter?.tryOpen(profileId);
      if (admit && !admit.ok) return reply.status(admit.status).send({ error: admit.message });
      const requestSlot = randomUUID();
      limiter?.register(requestSlot, profileId, () => reply.raw.destroy());
      limiter?.beginRequest(requestSlot);
      try {
        return await sessionless.handle(request, reply);
      } finally {
        limiter?.close(requestSlot);
      }
    }

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
          sessions.set(id, { transport, server, ac, profileId, probing: false, eventStreams: 0 });
          const session = sessions.get(id)!;
          ac.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(session.heartbeat);
            },
            { once: true }
          );
          limiter?.register(id, profileId, () => {
            // A reaped transport must stop being addressable immediately. Aborting only the
            // agent signal leaves the MCP session in `sessions`, so a stale client can keep using
            // it: reads work, while every HITL call sees the permanently-aborted signal and is
            // cancelled as soon as its approval is created.
            sessions.delete(id);
            ac.abort();
            void transport.close().catch((err: unknown) => {
              log.warn({ profileId, sessionId: id, err }, 'Failed to close reaped MCP transport');
            });
          });
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
    const reqLog = {
      profileId,
      reqId,
      httpMethod: request.method,
      sessionId: sessionId ?? 'init',
      protocolVersion: request.headers['mcp-protocol-version'],
    };
    const startedAt = Date.now();
    log.info(reqLog, 'MCP transport: request in');

    // Track request/response work so the idle reaper never severs a tool call that is actively
    // executing or parked for HITL approval. A streamable-HTTP GET is only the event channel: it
    // may sit open indefinitely after a half-dead client disappears, so counting it as work would
    // pin a leaked session forever. MCP heartbeats above refresh responsive clients; a dead GET
    // cannot answer a ping and becomes idle-reapable. Only meaningful for existing sessions
    // (a new session has no id yet during its initialize handshake, which is short-lived anyway).
    const eventSession =
      request.method === 'GET' && sessionId ? sessions.get(sessionId) : undefined;
    if (eventSession && sessionId) {
      eventSession.eventStreams += 1;
      scheduleHeartbeat(sessionId);
    }
    try {
      if (sessionId && limiter && request.method !== 'GET') {
        limiter.beginRequest(sessionId);
        try {
          await transport.handleRequest(request.raw, reply.raw, request.body);
        } finally {
          limiter.endRequest(sessionId);
        }
      } else {
        await transport.handleRequest(request.raw, reply.raw, request.body);
      }
    } finally {
      if (eventSession) {
        eventSession.eventStreams -= 1;
        if (eventSession.eventStreams === 0) {
          clearTimeout(eventSession.heartbeat);
          eventSession.heartbeat = undefined;
        }
      }
      log.info(
        { ...reqLog, statusCode: reply.raw.statusCode, ms: Date.now() - startedAt },
        'MCP transport: request done'
      );
    }
  }

  app.post('/agents/:profileId/mcp', handleMcpRequest);
  app.get('/agents/:profileId/mcp', handleMcpRequest);
  app.delete('/agents/:profileId/mcp', handleMcpRequest);
}
