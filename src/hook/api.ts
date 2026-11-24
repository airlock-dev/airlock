import type { FastifyInstance } from 'fastify';
import type { AllowlistEngine } from '../allowlist/engine.js';
import type {
  ApprovalMode,
  ApprovalPolicyOverrides,
  HitlEngine,
  HitlResult,
} from '../hitl/engine.js';
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
  /** Per-agent approval settings (`approval_mode`, `sync_wait_ms`); engine defaults otherwise. */
  getApprovalOverrides?: (agentId: string) => ApprovalPolicyOverrides | undefined;
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

    // The client runs the tool itself, so a hook never executes on approve: a "pending" answer is
    // followed by the model's retry, which the single-use grant lets through.
    const policy = hitlEngine.policyFor(opts.getApprovalOverrides?.(agentId));
    const pendingReply = () =>
      reply.send({
        decision: 'deny',
        tool: normalized.name,
        reason:
          // No approval code: the model reads this, and the code is what approves it in chat.
          'Approval pending in Airlock. Nothing was executed. ' +
          'Wait for the user to approve, then retry this exact call with identical input.',
      });
    if (policy.mode !== 'sync') {
      if (hitlEngine.wasRecentlyDenied(agentId, subject.fingerprint)) {
        return reply.send({
          decision: 'deny',
          tool: normalized.name,
          reason: 'Denied by operator',
        });
      }
      if (hitlEngine.findPendingCall(agentId, subject.fingerprint)) return pendingReply();
    }

    const ticket = createTicket(
      hitlEngine,
      hitlBatcher,
      agentId,
      normalized.name,
      input,
      subject,
      policy.mode
    );

    log.info({ ticket: ticket.id, code: ticket.code }, 'Hook waiting for HITL approval');

    // Hooks have short client-side timeouts: hold for at most the inline wait (async: none), then
    // answer "pending" and keep the request live.
    let result: HitlResult | 'pending';
    if (policy.mode === 'sync') {
      result = await ticket.result;
    } else {
      let timer: NodeJS.Timeout | undefined;
      result =
        policy.waitMs > 0
          ? await Promise.race([
              ticket.result,
              new Promise<'pending'>((resolve) => {
                timer = setTimeout(() => resolve('pending'), policy.waitMs);
                timer.unref();
              }),
            ])
          : 'pending';
      clearTimeout(timer);
      if (result === 'pending') {
        if (hitlEngine.spill(ticket.id)) return pendingReply();
        result = await ticket.result;
      }
    }

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
