import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { AirlockCallContext } from '../../airlock/context.js';
import type { SandboxDisplayInfo } from '../../sandbox/index.js';
import type { Middleware, ToolCallContext, ToolCallResponse } from '../types.js';
import { fingerprintCall, type ApprovalSubject } from '../../hitl/grants.js';
import { providerIdForTool } from '../../util/tool-name.js';

function errorResponse(message: string): ToolCallResponse {
  return {
    result: { content: [{ type: 'text', text: message }], isError: true },
    text: message,
  };
}

function serializeAuditArgs(args: Record<string, unknown>, meta: Record<string, unknown>): string {
  const sandbox = meta.sandbox_info;
  const context = meta.airlockContext as AirlockCallContext | undefined;
  const grant = meta.approvalGrantId as string | undefined;
  if (!sandbox && !context && !grant) return JSON.stringify(args);
  return JSON.stringify({
    ...args,
    _airlock: { ...(context ?? {}), ...(sandbox ? { sandbox } : {}), ...(grant ? { grant } : {}) },
  });
}

/** What the grant store and approval UIs need to know about this call. */
export function approvalSubjectFor(ctx: ToolCallContext): ApprovalSubject {
  const sessionId = ctx.meta.downstreamSessionId;
  return {
    agentId: ctx.agentId,
    tool: ctx.toolName,
    fingerprint: fingerprintCall(ctx.toolName, ctx.args),
    provider: providerIdForTool(ctx.toolName),
    tier: ctx.deps.registry.toolTier?.(ctx.agentId, ctx.toolName) ?? 'destructive',
    ...(typeof sessionId === 'string' ? { sessionId } : {}),
    escalated: ctx.meta.needsApproval === true,
  };
}

/**
 * What an agent learns about a pending approval. Never the approval code: that is what the operator
 * types to approve ("approve ABC123"), and an agent that can post into the approval chat would be
 * able to approve itself. The opaque id is only good for airlock_await_approval.
 */
function pendingResponse(tool: string, ticket: { id: string }): ToolCallResponse {
  const text =
    `Approval pending: Airlock asked the user to approve ${tool} (approval id ${ticket.id}). ` +
    'Nothing was executed. Once the user approves, retry this exact call with identical arguments. ' +
    'To wait for the decision, call airlock_await_approval with {"id": "' +
    ticket.id +
    '"} if that tool is available. Do not re-request it in the meantime.';
  return { result: { content: [{ type: 'text', text }], isError: true }, text };
}

const PROGRESS_INTERVAL_MS = 15_000;

/** Keep a held-open call alive for clients that reset their timeout on progress notifications. */
function startProgressKeepalive(ctx: ToolCallContext): () => void {
  const send = ctx.sendProgress;
  if (!send) return () => {};
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
    try {
      // No approval code here either: progress messages reach the agent's client.
      send(ticks, 'Waiting for human approval');
    } catch {
      /* best effort */
    }
  }, PROGRESS_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

export function hitlGateMiddleware(): Middleware {
  return async (ctx, next) => {
    if (!ctx.meta.needsApproval && !ctx.meta.policyAsk) return next();

    const { hitlEngine, hitlBatcher, auditLogger } = ctx.deps;
    const sandboxInfo = ctx.meta.sandbox_info as SandboxDisplayInfo | undefined;
    const airlockContext = ctx.meta.airlockContext as AirlockCallContext | undefined;
    const subject = approvalSubjectFor(ctx);

    const grant = hitlEngine.consumeGrant(subject);
    if (grant) {
      ctx.meta.approvalGrantId = grant.id;
      auditLogger.log({
        agent_id: ctx.agentId,
        request_id: ctx.callId,
        tool: ctx.toolName,
        args: serializeAuditArgs(ctx.args, ctx.meta),
        result: 'hitl_granted',
      });
      return next();
    }

    const mode = ctx.agentConfig.approval_mode ?? hitlEngine.defaultMode;
    if (mode === 'async') {
      if (hitlEngine.wasRecentlyDenied(subject.agentId, subject.fingerprint)) {
        auditLogger.log({
          agent_id: ctx.agentId,
          request_id: ctx.callId,
          tool: ctx.toolName,
          args: serializeAuditArgs(ctx.args, ctx.meta),
          result: 'hitl_denied',
        });
        return errorResponse(
          'Request denied by operator. Do not retry this call; ask the user how to proceed.'
        );
      }
      const existing = hitlEngine.findPendingCall(subject.agentId, subject.fingerprint);
      if (existing) return pendingResponse(ctx.toolName, existing);
    }

    // The engine redacts args before they are stored or shown to the operator.
    const ticket = hitlEngine.create({
      agentId: ctx.agentId,
      tool: ctx.toolName,
      args: ctx.args,
      ...(airlockContext ? { context: airlockContext } : {}),
      sandbox: sandboxInfo,
      kind: 'call',
      mode,
      subject,
    });

    const notification = hitlEngine.buildNotification(ticket.id);
    if (notification) hitlBatcher.add(notification);

    if (mode === 'async') {
      // The approval outlives this call: on approval the engine leaves a single-use grant that the
      // agent's retry consumes, so neither a client timeout nor a reconnect loses the decision.
      auditLogger.log({
        agent_id: ctx.agentId,
        request_id: ctx.callId,
        tool: ctx.toolName,
        args: serializeAuditArgs(ctx.args, ctx.meta),
        result: 'hitl_pending',
        hitl_code: ticket.code,
      });
      return pendingResponse(ctx.toolName, ticket);
    }

    const stopKeepalive = startProgressKeepalive(ctx);

    // If the transport provides an abort signal, race the HITL promise against it
    // so we don't execute a tool on a dead session.
    let result: Awaited<typeof ticket.result> | 'disconnected';
    try {
      if (ctx.signal && !ctx.signal.aborted) {
        result = await Promise.race([
          ticket.result,
          new Promise<'disconnected'>((resolve) => {
            if (ctx.signal!.aborted) {
              resolve('disconnected');
            } else {
              ctx.signal!.addEventListener('abort', () => resolve('disconnected'), { once: true });
            }
          }),
        ]);
      } else if (ctx.signal?.aborted) {
        // Already disconnected before we even started waiting
        result = 'disconnected';
      } else {
        result = await ticket.result;
      }
    } finally {
      stopKeepalive();
    }

    if (result === 'disconnected') {
      // With a zero/small batch window the notification timer may not have fired yet. Remove the
      // dead request first so operators never receive an approval push for a ticket that the
      // engine is about to mark cancelled and that no companion can open.
      hitlBatcher.remove(ticket.id);
      hitlEngine.cancel(ticket.id);
      auditLogger.log({
        agent_id: ctx.agentId,
        request_id: ctx.callId,
        tool: ctx.toolName,
        args: JSON.stringify(ctx.args),
        result: 'hitl_disconnected',
      });
      throw new ProtocolError(
        ProtocolErrorCode.InvalidRequest,
        'Session disconnected while awaiting approval'
      );
    }

    if (result === 'denied') {
      auditLogger.log({
        agent_id: ctx.agentId,
        request_id: ctx.callId,
        tool: ctx.toolName,
        args: serializeAuditArgs(ctx.args, ctx.meta),
        result: 'hitl_denied',
      });
      return errorResponse('Request denied by operator');
    }
    if (result === 'timeout') {
      auditLogger.log({
        agent_id: ctx.agentId,
        request_id: ctx.callId,
        tool: ctx.toolName,
        args: serializeAuditArgs(ctx.args, ctx.meta),
        result: 'hitl_timeout',
      });
      return errorResponse('Approval timed out. Re-request when operator is available.');
    }

    return next();
  };
}
