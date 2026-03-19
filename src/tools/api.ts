import { timingSafeEqual } from 'crypto';
import type { FastifyInstance } from 'fastify';
import type { AgentServerDeps } from '../transport/agent-server.js';
import type { ToolCallContext } from '../middleware/types.js';
import { buildMiddlewareChain } from '../middleware/chain-builder.js';
import { generateId } from '../util/id.js';
import { childLogger } from '../util/logger.js';

const log = childLogger('tools-api');

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export interface ToolsApiOpts {
  getDeps: (agentId: string) => AgentServerDeps | undefined;
  secret?: string;
}

// eslint-disable-next-line @typescript-eslint/require-await
export async function toolsApiPlugin(app: FastifyInstance, opts: ToolsApiOpts): Promise<void> {
  const { getDeps, secret } = opts;

  app.addHook('preHandler', async (request, reply) => {
    if (!secret) return;
    const auth = request.headers.authorization ?? '';
    if (!constantTimeEqual(auth, `Bearer ${secret}`)) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
  });

  app.get('/agents/:agentId/tools', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const deps = getDeps(agentId);
    if (!deps) {
      return reply.status(404).send({ error: `Unknown agent: ${agentId}` });
    }
    const tools = deps.registry.getFiltered(agentId);
    return reply.send({ tools });
  });

  app.post('/agents/:agentId/tools/invoke', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const body = request.body as { tool?: string; args?: Record<string, unknown> } | undefined;

    if (!body?.tool) {
      return reply.status(400).send({ error: 'Missing required field: tool' });
    }

    const { tool, args = {} } = body;

    const deps = getDeps(agentId);
    if (!deps) {
      return reply.status(404).send({ error: `Unknown agent: ${agentId}` });
    }

    const getConfig = deps.getAgentConfig ?? (() => deps.agentConfig);
    const agentConfig = getConfig();

    const chain = buildMiddlewareChain(agentConfig, {
      registry: deps.registry,
      allowlist: deps.allowlist,
      hitlEngine: deps.hitlEngine,
      hitlBatcher: deps.hitlBatcher,
      auditLogger: deps.auditLogger,
      securityConfig: deps.securityConfig ?? { blocked_hosts: [], allowed_local: [] },
    });

    const ctx: ToolCallContext = {
      callId: generateId(),
      agentId,
      agentConfig,
      toolName: tool,
      args,
      meta: {},
      deps: {
        registry: deps.registry,
        allowlist: deps.allowlist,
        hitlEngine: deps.hitlEngine,
        hitlBatcher: deps.hitlBatcher,
        auditLogger: deps.auditLogger,
        securityConfig: deps.securityConfig ?? { blocked_hosts: [], allowed_local: [] },
      },
      startedAt: Date.now(),
    };

    try {
      const response = await chain(ctx, () => {
        throw new Error('Middleware chain did not terminate — missing execute middleware');
      });
      const duration_ms = Date.now() - ctx.startedAt;
      return reply.send({
        success: true,
        data: response.result,
        metadata: { duration_ms, truncated: response.truncated ?? false },
      });
    } catch (err) {
      const duration_ms = Date.now() - ctx.startedAt;
      log.warn({ err, agentId, tool }, 'Tool invocation failed');
      return reply.send({
        success: false,
        error: err instanceof Error ? err.message : String(err),
        metadata: { duration_ms },
      });
    }
  });
}
