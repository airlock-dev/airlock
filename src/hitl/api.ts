import type { FastifyInstance } from 'fastify';
import type { HitlEngine } from './engine.js';
import { checkRequestSecurity } from '../security/request.js';

// eslint-disable-next-line @typescript-eslint/require-await
export async function hitlApiPlugin(
  app: FastifyInstance,
  opts: { engine: HitlEngine; secret?: string; authRequired?: boolean; allowedOrigins?: string[] }
): Promise<void> {
  const { engine } = opts;

  app.addHook('preHandler', async (request, reply) => {
    if (!checkRequestSecurity(request, reply, opts)) {
      return;
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
