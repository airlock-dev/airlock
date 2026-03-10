import type { FastifyInstance } from 'fastify';
import type { HitlEngine } from './engine.js';

export async function hitlApiPlugin(
  app: FastifyInstance,
  opts: { engine: HitlEngine; secret?: string },
): Promise<void> {
  const { engine, secret } = opts;

  app.addHook('preHandler', async (request, reply) => {
    if (!secret) return;
    const auth = request.headers.authorization;
    if (auth !== `Bearer ${secret}`) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
  });

  app.post('/hitl/approve/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    engine.approve(id);
    return reply.send({ ok: true });
  });

  app.post('/hitl/deny/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { reason?: string } | undefined;
    engine.deny(id, body?.reason);
    return reply.send({ ok: true });
  });

  app.get('/hitl/pending', async (_request, reply) => {
    return reply.send(engine.getPending());
  });
}
