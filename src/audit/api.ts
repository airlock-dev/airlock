import type { FastifyInstance } from 'fastify';
import type { AuditLogger } from './logger.js';
import { checkRequestSecurity, type RequestSecurityOptions } from '../security/request.js';

// eslint-disable-next-line @typescript-eslint/require-await
export async function auditApiPlugin(
  app: FastifyInstance,
  opts: {
    auditLogger: AuditLogger;
	    secret?: string;
	    authRequired?: boolean;
	    allowedOrigins?: string[];
	    getRequestSecurity?: () => RequestSecurityOptions;
	  }
): Promise<void> {
  const { auditLogger } = opts;

  app.addHook('preHandler', async (request, reply) => {
    if (!checkRequestSecurity(request, reply, opts)) {
      return;
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
