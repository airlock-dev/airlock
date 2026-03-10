import { timingSafeEqual } from 'crypto';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createAgentServer, connectAgentServer } from './agent-server.js';
import type { AgentServerDeps } from './agent-server.js';
import { childLogger } from '../util/logger.js';

const log = childLogger('sse-server');

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export async function sseServerPlugin(
  app: FastifyInstance,
  opts: {
    getDeps: (agentId: string) => AgentServerDeps | undefined;
    secret?: string;
  },
): Promise<void> {
  const { secret } = opts;
  const sessions = new Map<string, SSEServerTransport>();

  // Auth for SSE endpoints
  app.addHook('preHandler', async (request, reply) => {
    if (!secret) return;
    const auth = request.headers.authorization ?? '';
    if (!constantTimeEqual(auth, `Bearer ${secret}`)) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
  });

  app.get('/agents/:profileId/sse', async (request: FastifyRequest, reply: FastifyReply) => {
    const { profileId } = request.params as { profileId: string };

    const deps = opts.getDeps(profileId);
    if (!deps) {
      return reply.status(404).send({ error: `Unknown agent profile: ${profileId}` });
    }

    log.info({ profileId }, 'New SSE connection');

    const transport = new SSEServerTransport('/agents/' + profileId + '/messages', reply.raw);
    sessions.set(transport.sessionId, transport);

    transport.onclose = () => {
      sessions.delete(transport.sessionId);
      log.info({ profileId, sessionId: transport.sessionId }, 'SSE session closed');
    };

    const server = createAgentServer(deps);
    await connectAgentServer(server, transport);

    // Keep connection open
    request.raw.on('close', () => {
      sessions.delete(transport.sessionId);
    });
  });

  app.post('/agents/:profileId/messages', async (request: FastifyRequest, reply: FastifyReply) => {
    const { sessionId } = request.query as { sessionId?: string };

    if (!sessionId) {
      return reply.status(400).send({ error: 'sessionId query param required' });
    }

    const transport = sessions.get(sessionId);
    if (!transport) {
      return reply.status(404).send({ error: `Session not found: ${sessionId}` });
    }

    await transport.handlePostMessage(request.raw, reply.raw);
  });
}
