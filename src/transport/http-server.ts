import { randomUUID } from 'crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createAgentServer, connectAgentServer } from './agent-server.js';
import type { AgentServerDeps } from './agent-server.js';
import { childLogger } from '../util/logger.js';
import { checkBearerAuth, checkOrigin } from '../security/request.js';

const log = childLogger('http-server');

// eslint-disable-next-line @typescript-eslint/require-await
export async function httpServerPlugin(
  app: FastifyInstance,
  opts: {
    getDeps: (agentId: string) => AgentServerDeps | undefined;
    secret?: string;
    authRequired?: boolean;
    allowedOrigins?: string[];
  }
): Promise<void> {
  const { secret } = opts;
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
    if (!checkOrigin(request, reply, opts.allowedOrigins)) return false;

    const token = deps.agentConfig.token;
    if (token) {
      return checkBearerAuth(request, reply, { secret: token, authRequired: true });
    }
    return checkBearerAuth(request, reply, {
      secret,
      authRequired: opts.authRequired,
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

    let transport: StreamableHTTPServerTransport;

    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        return reply.status(404).send({ error: `Session not found: ${sessionId}` });
      }
      if (session.profileId !== profileId) {
        return reply.status(403).send({ error: 'Session does not belong to this agent' });
      }
      transport = session.transport;
    } else {
      // New session — create transport + MCP server before the initialize handshake.
      const ac = new AbortController();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, ac, profileId });
          log.info({ profileId, sessionId: id }, 'HTTP session initialized');
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
          ac.abort();
          log.info({ profileId, sessionId: id }, 'HTTP session closed');
        },
      });

      const server = createAgentServer({ ...deps, signal: ac.signal });
      await connectAgentServer(server, transport);

      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) sessions.delete(id);
        ac.abort();
      };
    }

    // Hand off raw Node.js req/res — Fastify must not touch the response after this.
    reply.hijack();
    await transport.handleRequest(request.raw, reply.raw);
  }

  app.post('/agents/:profileId/mcp', handleMcpRequest);
  app.get('/agents/:profileId/mcp', handleMcpRequest);
  app.delete('/agents/:profileId/mcp', handleMcpRequest);
}
