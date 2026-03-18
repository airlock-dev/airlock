import { timingSafeEqual } from 'crypto';
import type { FastifyInstance } from 'fastify';
import type { AllowlistEngine } from '../allowlist/engine.js';
import type { HitlEngine } from '../hitl/engine.js';
import type { HitlBatcher } from '../hitl/batcher.js';
import type { AuditLogger } from '../audit/logger.js';
import { normalizeTool } from './normalizer.js';
import { childLogger } from '../util/logger.js';

const log = childLogger('hook-api');

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export interface HookApiOpts {
  allowlist: AllowlistEngine;
  hitlEngine: HitlEngine;
  hitlBatcher: HitlBatcher;
  auditLogger: AuditLogger;
  secret?: string;
}

interface HookRequestBody {
  client: string;
  agent?: string;
  tool: string;
  input: Record<string, unknown>;
  session_id?: string;
}

// eslint-disable-next-line @typescript-eslint/require-await
export async function hookApiPlugin(app: FastifyInstance, opts: HookApiOpts): Promise<void> {
  const { allowlist, hitlEngine, hitlBatcher, auditLogger, secret } = opts;

  app.addHook('preHandler', async (request, reply) => {
    if (!secret) return;
    const auth = request.headers.authorization ?? '';
    if (!constantTimeEqual(auth, `Bearer ${secret}`)) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
  });

  app.post('/hook', async (request, reply) => {
    const body = request.body as HookRequestBody | undefined;

    if (!body?.client || !body?.tool) {
      return reply.status(400).send({ error: 'Missing required fields: client, tool' });
    }

    const { client, agent, tool, input = {}, session_id } = body;

    // Explicit agent takes precedence, otherwise fall back to client name
    const agentId = agent ?? client;
    const normalized = normalizeTool(client, tool, input);

    log.info({ client, agent: agentId, tool, normalized: normalized.name, session_id }, 'Hook evaluation request');

    const decision = allowlist.evaluate(agentId, normalized.name);

    // Log to audit
    auditLogger.log({
      agent_id: agentId,
      tool: normalized.name,
      args: JSON.stringify(input),
      result: `hook_${decision}`,
    });

    if (decision === 'allow') {
      return reply.send({ decision: 'allow', tool: normalized.name });
    }

    if (decision === 'deny') {
      return reply.send({
        decision: 'deny',
        tool: normalized.name,
        reason: 'Tool not allowed by policy',
      });
    }

    // decision === 'ask' — create HITL ticket and long-poll
    const ticket = hitlEngine.create({
      agentId,
      tool: normalized.name,
      args: input,
    });

    hitlBatcher.add({
      id: ticket.id,
      code: ticket.code,
      agentId,
      tool: normalized.name,
      args: input,
      timeoutMs: hitlEngine.timeoutMs,
    });

    log.info({ ticket: ticket.id, code: ticket.code }, 'Hook waiting for HITL approval');

    const result = await ticket.result;

    if (result === 'approved') {
      return reply.send({ decision: 'allow', tool: normalized.name });
    }

    const reason = result === 'timeout' ? 'Approval timed out' : 'Denied by operator';
    return reply.send({ decision: 'deny', tool: normalized.name, reason });
  });
}
