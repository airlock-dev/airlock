import type { FastifyInstance } from 'fastify';
import type { AuditLogger } from './logger.js';

export async function auditApiPlugin(
  app: FastifyInstance,
  opts: { auditLogger: AuditLogger; secret?: string },
): Promise<void> {
  const { auditLogger, secret } = opts;

  app.addHook('preHandler', async (request, reply) => {
    if (!secret) return;
    const auth = request.headers.authorization;
    if (auth !== `Bearer ${secret}`) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
  });

  app.get('/audit', async (request, reply) => {
    const { agent, tool, since, limit } = request.query as Record<string, string>;
    const entries = auditLogger.query({
      agent,
      tool,
      since,
      limit: limit ? parseInt(limit, 10) : 100,
    });
    return reply.send(entries);
  });
}
