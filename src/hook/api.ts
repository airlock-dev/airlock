import type { FastifyInstance } from 'fastify';
import type { AllowlistEngine } from '../allowlist/engine.js';
import type { ApprovalMode, HitlEngine } from '../hitl/engine.js';
import { fingerprintCall, type ApprovalSubject, type ToolTier } from '../hitl/grants.js';
import type { HitlBatcher } from '../hitl/batcher.js';
import type { AuditLogger } from '../audit/logger.js';
import { normalizeTool } from './normalizer.js';
import { childLogger } from '../util/logger.js';
import { providerIdForTool } from '../util/tool-name.js';
import { checkRequestSecurity, type RequestSecurityOptions } from '../security/request.js';

const log = childLogger('hook-api');

export interface HookApiOpts {
  allowlist: AllowlistEngine;
  hitlEngine: HitlEngine;
  hitlBatcher: HitlBatcher;
  auditLogger: AuditLogger;
  /** Per-agent approval mode override (falls back to the engine default). */
  getApprovalMode?: (agentId: string) => ApprovalMode | undefined;
  /** Safety tier for tier-scoped grants. Unknown tools are treated as destructive. */
  getToolTier?: (agentId: string, tool: string) => ToolTier;
  secret?: string;
  authRequired?: boolean;
  allowedOrigins?: string[];
  getRequestSecurity?: () => RequestSecurityOptions;
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
  const { allowlist, hitlEngine, hitlBatcher, auditLogger } = opts;

  app.addHook('preHandler', async (request, reply) => {
    if (!checkRequestSecurity(request, reply, opts)) {
      return;
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

    log.info(
      { client, agent: agentId, tool, normalized: normalized.name, session_id },
      'Hook evaluation request'
    );

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

    // decision === 'ask' — a grant may already cover it; otherwise create a HITL ticket.
    const subject: ApprovalSubject = {
      agentId,
      tool: normalized.name,
      fingerprint: fingerprintCall(normalized.name, input),
      provider: providerIdForTool(normalized.name),
      tier: opts.getToolTier?.(agentId, normalized.name) ?? 'destructive',
      ...(session_id ? { sessionId: session_id } : {}),
      escalated: false,
    };
    const grant = hitlEngine.consumeGrant(subject);
    if (grant) {
      auditLogger.log({
        agent_id: agentId,
        tool: normalized.name,
        args: JSON.stringify({ ...input, _airlock: { grant: grant.id } }),
        result: 'hitl_granted',
      });
      return reply.send({ decision: 'allow', tool: normalized.name });
    }

    const mode = opts.getApprovalMode?.(agentId) ?? hitlEngine.defaultMode;
    if (mode === 'async') {
      // Hooks have short client-side timeouts. Answer at once: the deny reason tells the model the
      // approval is pending, and once approved its retry of the same call is let through.
      if (hitlEngine.wasRecentlyDenied(agentId, subject.fingerprint)) {
        return reply.send({
          decision: 'deny',
          tool: normalized.name,
          reason: 'Denied by operator',
        });
      }
      const pending =
        hitlEngine.findPendingCall(agentId, subject.fingerprint) ??
        createTicket(hitlEngine, hitlBatcher, agentId, normalized.name, input, subject, 'async');
      return reply.send({
        decision: 'deny',
        tool: normalized.name,
        reason:
          // No approval code: the model reads this, and the code is what approves it in chat.
          'Approval pending in Airlock. Nothing was executed. ' +
          'Wait for the user to approve, then retry this exact call with identical input.',
      });
    }

    const ticket = createTicket(
      hitlEngine,
      hitlBatcher,
      agentId,
      normalized.name,
      input,
      subject,
      'sync'
    );

    log.info({ ticket: ticket.id, code: ticket.code }, 'Hook waiting for HITL approval');

    const result = await ticket.result;

    if (result === 'approved') {
      return reply.send({ decision: 'allow', tool: normalized.name });
    }

    const reason = result === 'timeout' ? 'Approval timed out' : 'Denied by operator';
    return reply.send({ decision: 'deny', tool: normalized.name, reason });
  });
}

function createTicket(
  hitlEngine: HitlEngine,
  hitlBatcher: HitlBatcher,
  agentId: string,
  tool: string,
  args: Record<string, unknown>,
  subject: ApprovalSubject,
  mode: ApprovalMode
): ReturnType<HitlEngine['create']> {
  const ticket = hitlEngine.create({ agentId, tool, args, kind: 'call', mode, subject });
  const notification = hitlEngine.buildNotification(ticket.id);
  if (notification) hitlBatcher.add(notification);
  return ticket;
}
