import AjvModule from 'ajv';
import type { ValidateFunction } from 'ajv';
import type { Notification } from '@modelcontextprotocol/server';
import type { AllowlistEngine } from '../allowlist/engine.js';
import type { AuditLogger } from '../audit/logger.js';
import type { AgentConfig } from '../config/schema.js';
import type { HitlBatcher } from '../hitl/batcher.js';
import type { HitlEngine } from '../hitl/engine.js';
import { fingerprintCall, type ApprovalSubject } from '../hitl/grants.js';
import { evaluateArgPolicy } from '../middleware/core/arg-policy.js';
import { providerIdForTool } from '../util/tool-name.js';
import { generateId } from '../util/id.js';
import { stableStringify } from '../util/stable-json.js';
import { childLogger } from '../util/logger.js';
import { inspectEventOccurrence } from './payload-inspector.js';
import type { EventRegistry, RegisteredEvent } from './registry.js';
import type { EventStreamManager } from './stream-manager.js';
import type {
  UpstreamEventStreamCallbacks,
  UpstreamEventStreamHandle,
  UpstreamEventStreamOptions,
} from './upstream-client.js';
import {
  EVENT_NOTIFICATIONS,
  EVENTS_ERROR_CODES,
  SUBSCRIPTION_ID_META_KEY,
  createEventsError,
  validateEventRoutingHeaders,
  type EventStreamErrorObject,
  type EventsListParams,
  type EventsListResult,
  type EventsPollParams,
  type EventsPollResult,
  type EventsStreamParams,
  type EventsStreamResult,
} from './protocol.js';

const log = childLogger('events:service');

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true, strict: false });
const validatorCache = new WeakMap<object, ValidateFunction>();
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

const POLL_APPROVAL_MIN_TTL_MS = 5 * 60_000;
const POLL_APPROVAL_MAX_ENTRIES = 10_000;

export interface EventUpstreamPool {
  pollEvents(
    mcpId: string,
    params: EventsPollParams,
    options?: { inputSchema?: Record<string, unknown>; signal?: AbortSignal }
  ): Promise<EventsPollResult>;
  openEventStream(
    mcpId: string,
    params: EventsStreamParams,
    callbacks: UpstreamEventStreamCallbacks,
    options?: UpstreamEventStreamOptions
  ): Promise<UpstreamEventStreamHandle>;
}

export interface EventServiceDeps {
  pool: EventUpstreamPool;
  registry: EventRegistry;
  allowlist: AllowlistEngine;
  streamManager: EventStreamManager;
  hitlEngine: HitlEngine;
  hitlBatcher: HitlBatcher;
  auditLogger: AuditLogger;
  getAgentConfig: (agentId: string) => AgentConfig | undefined;
}

export interface EventRequestContext {
  agentId: string;
  agentConfig: AgentConfig;
  requestId: string | number;
  downstreamSessionId?: string;
  httpReq?: Request;
  signal?: AbortSignal;
  notify: (notification: Notification) => Promise<void>;
}

/**
 * Policy-enforcing, payload-inspecting, audit-logging SEP-3415 Events proxy service.
 */
export class EventService {
  /**
   * Approved `ask`-tier poll subscriptions, keyed by `(agentId, eventName, canonicalArgs)`.
   * Avoids re-prompting the human on every poll interval once a subscription has been approved,
   * while expiring automatically if the agent stops polling and clearing immediately on revocation.
   */
  private readonly approvedPolls = new Map<string, number>();

  constructor(private readonly deps: EventServiceDeps) {}

  /**
   * Whether `io.modelcontextprotocol/events` should be advertised for this agent.
   * True when the agent either has visible discovered events OR has event allow/ask rules
   * configured (so a client connecting before a slow upstream finishes connecting still knows
   * events are enabled for this profile).
   */
  shouldAdvertiseFor(agentId: string, agentConfig: AgentConfig): boolean {
    if (this.deps.registry.hasEventsFor(agentId)) return true;
    const ev = agentConfig.events;
    return Boolean(ev && (ev.allow.length > 0 || ev.ask.length > 0));
  }

  handleList(agentId: string, _params: EventsListParams): EventsListResult {
    const events = this.deps.registry.getFiltered(agentId);
    return {
      resultType: 'complete',
      events,
    };
  }

  async handlePoll(ctx: EventRequestContext, params: EventsPollParams): Promise<EventsPollResult> {
    const callId = generateId();
    const args = params.arguments ?? {};
    const { registered, decision } = this.authorizeAndValidate(
      ctx,
      callId,
      params.name,
      args,
      'poll'
    );

    if (decision === 'ask') {
      await this.requirePollApproval(ctx, callId, params.name, args, params.cursor ?? null);
    }

    const upstreamParams: EventsPollParams = {
      name: registered.upstreamName,
      ...(params.arguments !== undefined ? { arguments: params.arguments } : {}),
      ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
      ...(params.maxAgeMs !== undefined ? { maxAgeMs: params.maxAgeMs } : {}),
      ...(params.maxEvents !== undefined ? { maxEvents: params.maxEvents } : {}),
    };

    const startedAt = Date.now();
    let rawResult: EventsPollResult;
    try {
      rawResult = await this.deps.pool.pollEvents(registered.providerId, upstreamParams, {
        inputSchema: registered.descriptor.inputSchema,
        signal: ctx.signal,
      });
    } catch (err) {
      this.deps.auditLogger.log({
        agent_id: ctx.agentId,
        request_id: callId,
        tool: `event:${params.name}`,
        args: JSON.stringify(args),
        result: 'error',
        duration_ms: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    // Refresh approved-poll lease when this subscription is ask-gated.
    if (decision === 'ask') {
      const leaseMs = Math.max((rawResult.nextPollMs ?? 30_000) * 4, POLL_APPROVAL_MIN_TTL_MS);
      this.setPollApprovalLease(ctx.agentId, params.name, args, Date.now() + leaseMs);
    }

    const inspectedEvents = rawResult.events.map((occurrence) =>
      inspectEventOccurrence({
        agentId: ctx.agentId,
        agentConfig: ctx.agentConfig,
        namespacedEventName: params.name,
        occurrence,
        auditLogger: this.deps.auditLogger,
        requestId: callId,
      })
    );

    this.deps.auditLogger.log({
      agent_id: ctx.agentId,
      request_id: callId,
      tool: `event:${params.name}`,
      args: JSON.stringify(args),
      result: 'success',
      duration_ms: Date.now() - startedAt,
    });

    return {
      resultType: 'complete',
      events: inspectedEvents,
      ...(rawResult.cursor !== undefined ? { cursor: rawResult.cursor } : {}),
      ...(rawResult.truncated !== undefined ? { truncated: rawResult.truncated } : {}),
      ...(rawResult.hasMore !== undefined ? { hasMore: rawResult.hasMore } : {}),
      ...(rawResult.nextPollMs !== undefined ? { nextPollMs: rawResult.nextPollMs } : {}),
    };
  }

  async handleStream(
    ctx: EventRequestContext,
    params: EventsStreamParams
  ): Promise<EventsStreamResult> {
    const callId = generateId();
    const args = params.arguments ?? {};
    const { registered, decision } = this.authorizeAndValidate(
      ctx,
      callId,
      params.name,
      args,
      'push'
    );

    // Check dedicated per-agent / global stream cap before hitting HITL or opening upstream.
    this.deps.streamManager.tryAdmit(ctx.agentId);

    if (decision === 'ask') {
      await this.requireApproval(ctx, callId, params.name, args, 'push');
    }

    // Re-check cap after a potentially long HITL approval wait.
    this.deps.streamManager.tryAdmit(ctx.agentId);

    const subscriptionMeta = { [SUBSCRIPTION_ID_META_KEY]: ctx.requestId };
    const streamAbort = new AbortController();
    const onCallerAbort = () => streamAbort.abort(ctx.signal?.reason);
    if (ctx.signal) {
      if (ctx.signal.aborted) {
        throw createEventsError(EVENTS_ERROR_CODES.Forbidden, 'Stream aborted before opening');
      }
      ctx.signal.addEventListener('abort', onCallerAbort, { once: true });
    }

    const emitDownstream = async (method: string, notifParams: Record<string, unknown>) => {
      if (streamAbort.signal.aborted) return;
      const existingMeta =
        notifParams._meta && typeof notifParams._meta === 'object'
          ? (notifParams._meta as Record<string, unknown>)
          : {};
      await ctx
        .notify({
          method,
          params: {
            ...notifParams,
            _meta: { ...existingMeta, ...subscriptionMeta },
          },
        } as Notification)
        .catch(() => {
          // Downstream transport closed — abort upstream cleanly.
          streamAbort.abort();
        });
    };

    const upstreamParams: EventsStreamParams = {
      name: registered.upstreamName,
      ...(params.arguments !== undefined ? { arguments: params.arguments } : {}),
      ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
      ...(params.maxAgeMs !== undefined ? { maxAgeMs: params.maxAgeMs } : {}),
      ...(params.heartbeatMs !== undefined ? { heartbeatMs: params.heartbeatMs } : {}),
    };

    const startedAt = Date.now();
    let upstreamHandle: UpstreamEventStreamHandle;
    try {
      upstreamHandle = await this.deps.pool.openEventStream(
        registered.providerId,
        upstreamParams,
        {
          onActive: async (active) => {
            await emitDownstream(EVENT_NOTIFICATIONS.active, {
              ...(active.cursor !== undefined ? { cursor: active.cursor } : {}),
              ...(active.truncated !== undefined ? { truncated: active.truncated } : {}),
              ...(active.heartbeatMs !== undefined ? { heartbeatMs: active.heartbeatMs } : {}),
            });
          },
          onEvent: async (occurrence) => {
            // Re-read latest agent config so hot-reloaded middleware (e.g. injection mangle mode)
            // takes effect immediately on already-open streams.
            const liveAgentConfig = this.deps.getAgentConfig(ctx.agentId) ?? ctx.agentConfig;
            const inspected = inspectEventOccurrence({
              agentId: ctx.agentId,
              agentConfig: liveAgentConfig,
              namespacedEventName: params.name,
              occurrence,
              auditLogger: this.deps.auditLogger,
              requestId: callId,
            });
            await emitDownstream(EVENT_NOTIFICATIONS.event, inspected);
          },
          onHeartbeat: async (hb) => {
            await emitDownstream(EVENT_NOTIFICATIONS.heartbeat, {
              ...(hb.cursor !== undefined ? { cursor: hb.cursor } : {}),
            });
          },
          onError: async (errParams) => {
            await emitDownstream(EVENT_NOTIFICATIONS.error, { error: errParams.error });
          },
          onTerminated: async (termParams) => {
            await emitDownstream(EVENT_NOTIFICATIONS.terminated, { error: termParams.error });
          },
        },
        {
          signal: streamAbort.signal,
          inputSchema: registered.descriptor.inputSchema,
        }
      );
    } catch (err) {
      ctx.signal?.removeEventListener('abort', onCallerAbort);
      this.deps.auditLogger.log({
        agent_id: ctx.agentId,
        request_id: callId,
        tool: `event:${params.name}`,
        args: JSON.stringify(args),
        result: 'error',
        duration_ms: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    let terminatedByGateway = false;
    this.deps.streamManager.register({
      id: callId,
      agentId: ctx.agentId,
      eventName: params.name,
      args,
      terminate: async (error: EventStreamErrorObject) => {
        if (terminatedByGateway) return;
        terminatedByGateway = true;
        await emitDownstream(EVENT_NOTIFICATIONS.terminated, { error });
        streamAbort.abort();
        await upstreamHandle.close();
      },
      closeGracefully: async () => {
        streamAbort.abort();
        await upstreamHandle.close();
      },
    });

    this.deps.auditLogger.log({
      agent_id: ctx.agentId,
      request_id: callId,
      tool: `event:${params.name}`,
      args: JSON.stringify(args),
      result: 'success',
      duration_ms: Date.now() - startedAt,
    });

    try {
      // Forward the initial `notifications/events/active` confirmation.
      const { active } = upstreamHandle;
      await emitDownstream(EVENT_NOTIFICATIONS.active, {
        ...(active.cursor !== undefined ? { cursor: active.cursor } : {}),
        ...(active.truncated !== undefined ? { truncated: active.truncated } : {}),
        ...(active.heartbeatMs !== undefined ? { heartbeatMs: active.heartbeatMs } : {}),
      });

      await upstreamHandle.closed;
    } finally {
      this.deps.streamManager.unregister(callId);
      ctx.signal?.removeEventListener('abort', onCallerAbort);
    }

    return {
      resultType: 'complete',
      _meta: subscriptionMeta,
    };
  }

  handleUnsupportedWebhook(ctx: EventRequestContext, eventName: string): never {
    this.deps.auditLogger.log({
      agent_id: ctx.agentId,
      request_id: generateId(),
      tool: `event:${eventName}`,
      args: '{}',
      result: 'denied',
      error: 'Webhook delivery is not supported by Airlock gateway; use poll or push delivery.',
    });
    throw createEventsError(
      EVENTS_ERROR_CODES.Unsupported,
      'Webhook delivery is not supported by Airlock gateway; use poll or push delivery.',
      { feature: 'deliveryMode', value: 'webhook' }
    );
  }

  /**
   * Re-evaluate every live stream and approved poll lease after a config or catalog reload.
   * Revoked streams receive `notifications/events/terminated` with `Forbidden` (`-32024`) or
   * `NotFound` (`-32023`) per SEP-3415.
   */
  async reconcileAfterReload(): Promise<void> {
    // Clear poll leases whose event or arg_policy is no longer allowed.
    for (const [key, expiresAt] of this.approvedPolls) {
      if (expiresAt <= Date.now()) {
        this.approvedPolls.delete(key);
        continue;
      }
      const [agentId, eventName, argsJson] = parsePollLeaseKey(key);
      if (!agentId || !eventName) {
        this.approvedPolls.delete(key);
        continue;
      }
      let parsedArgs: Record<string, unknown>;
      try {
        parsedArgs = JSON.parse(argsJson) as Record<string, unknown>;
      } catch {
        this.approvedPolls.delete(key);
        continue;
      }
      if (this.checkLiveStreamAccess(agentId, eventName, parsedArgs) !== undefined) {
        this.approvedPolls.delete(key);
      }
    }

    await this.deps.streamManager.revokeDisallowed(({ agentId, eventName, args }) =>
      this.checkLiveStreamAccess(agentId, eventName, args)
    );
  }

  private checkLiveStreamAccess(
    agentId: string,
    eventName: string,
    args: Record<string, unknown>
  ): EventStreamErrorObject | undefined {
    const agentConfig = this.deps.getAgentConfig(agentId);
    if (!agentConfig) {
      return {
        code: EVENTS_ERROR_CODES.Forbidden,
        message: 'Forbidden',
        data: { reason: 'Agent removed' },
      };
    }

    const decision = this.deps.allowlist.evaluateEvent(agentId, eventName);
    if (decision === 'deny') {
      return {
        code: EVENTS_ERROR_CODES.Forbidden,
        message: 'Forbidden',
        data: { reason: 'Access revoked' },
      };
    }

    const registered = this.deps.registry.getByName(eventName);
    if (!registered) {
      return {
        code: EVENTS_ERROR_CODES.NotFound,
        message: 'NotFound',
        data: { kind: 'event' },
      };
    }

    const argPolicy = agentConfig.events?.arg_policy?.[eventName];
    if (argPolicy) {
      const violation = evaluateArgPolicy(argPolicy, eventName, args);
      if (violation) {
        return {
          code: EVENTS_ERROR_CODES.Forbidden,
          message: 'Forbidden',
          data: { reason: violation },
        };
      }
    }

    return undefined;
  }

  private authorizeAndValidate(
    ctx: EventRequestContext,
    callId: string,
    eventName: string,
    args: Record<string, unknown>,
    mode: 'poll' | 'push'
  ): { registered: RegisteredEvent; decision: 'allow' | 'ask' } {
    const registered = this.deps.registry.getByName(eventName);
    const decision = this.deps.allowlist.evaluateEvent(ctx.agentId, eventName);

    // Validate routing headers first when present on HTTP (SEP-3415 / SEP-2243).
    validateEventRoutingHeaders(ctx.httpReq, eventName, args, registered?.descriptor.inputSchema);

    if (decision === 'deny') {
      this.deps.auditLogger.log({
        agent_id: ctx.agentId,
        request_id: callId,
        tool: `event:${eventName}`,
        args: JSON.stringify(args),
        result: 'denied',
        error: `Event ${eventName} is not allowed for agent ${ctx.agentId}`,
      });
      throw createEventsError(EVENTS_ERROR_CODES.Forbidden, `Event not allowed: ${eventName}`, {
        reason: 'Event denied by policy',
      });
    }

    if (!registered) {
      throw createEventsError(EVENTS_ERROR_CODES.NotFound, `Unknown event: ${eventName}`, {
        kind: 'event',
      });
    }

    if (!registered.descriptor.delivery.includes(mode)) {
      throw createEventsError(
        EVENTS_ERROR_CODES.Unsupported,
        `Event ${eventName} does not support delivery mode "${mode}"`,
        { feature: 'deliveryMode', value: mode }
      );
    }

    // Validate subscription arguments against the event's `inputSchema`.
    if (registered.descriptor.inputSchema) {
      let validate = validatorCache.get(registered.descriptor.inputSchema);
      if (!validate) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        validate = ajv.compile(registered.descriptor.inputSchema) as ValidateFunction;
        validatorCache.set(registered.descriptor.inputSchema, validate);
      }
      if (!validate(args)) {
        const errors =
          (validate.errors ?? [])
            .map((e) => `${e.instancePath || '/'}: ${e.message ?? 'unknown error'}`)
            .join('; ') || 'Unknown validation error';
        throw createEventsError(
          EVENTS_ERROR_CODES.InvalidParams,
          `Invalid subscription arguments for ${eventName}: ${errors}`
        );
      }
    }

    // Enforce event argument policy (`events.arg_policy[eventName]`).
    const argPolicy = ctx.agentConfig.events?.arg_policy?.[eventName];
    if (argPolicy) {
      const violation = evaluateArgPolicy(argPolicy, eventName, args);
      if (violation) {
        this.deps.auditLogger.log({
          agent_id: ctx.agentId,
          request_id: callId,
          tool: `event:${eventName}`,
          args: JSON.stringify(args),
          result: 'arg_policy_denied',
          error: violation,
        });
        throw createEventsError(EVENTS_ERROR_CODES.Forbidden, violation, {
          reason: 'arg_policy_denied',
        });
      }
    }

    return { registered, decision };
  }

  private async requirePollApproval(
    ctx: EventRequestContext,
    callId: string,
    eventName: string,
    args: Record<string, unknown>,
    cursor: string | null
  ): Promise<void> {
    const key = pollLeaseKey(ctx.agentId, eventName, args);
    const expiresAt = this.approvedPolls.get(key);
    if (cursor !== null && expiresAt !== undefined && expiresAt > Date.now()) {
      return;
    }

    await this.requireApproval(ctx, callId, eventName, args, 'poll');
    this.setPollApprovalLease(ctx.agentId, eventName, args, Date.now() + POLL_APPROVAL_MIN_TTL_MS);
  }

  private setPollApprovalLease(
    agentId: string,
    eventName: string,
    args: Record<string, unknown>,
    expiresAt: number
  ): void {
    const key = pollLeaseKey(agentId, eventName, args);
    if (this.approvedPolls.has(key)) {
      this.approvedPolls.delete(key);
    } else if (this.approvedPolls.size >= POLL_APPROVAL_MAX_ENTRIES) {
      const oldest = this.approvedPolls.keys().next().value;
      if (oldest !== undefined) this.approvedPolls.delete(oldest);
    }
    this.approvedPolls.set(key, expiresAt);
  }

  private async requireApproval(
    ctx: EventRequestContext,
    callId: string,
    eventName: string,
    args: Record<string, unknown>,
    mode: 'poll' | 'push'
  ): Promise<void> {
    const { hitlEngine, hitlBatcher, auditLogger } = this.deps;
    const approvalTarget = `event:${eventName}`;
    const approvalArgs = { delivery: mode, arguments: args };
    const subject: ApprovalSubject = {
      agentId: ctx.agentId,
      tool: approvalTarget,
      fingerprint: fingerprintCall(approvalTarget, approvalArgs),
      provider: providerIdForTool(eventName),
      tier: 'read',
      escalated: false,
      ...(ctx.downstreamSessionId ? { sessionId: ctx.downstreamSessionId } : {}),
    };

    const grant = hitlEngine.consumeGrant(subject);
    if (grant) {
      auditLogger.log({
        agent_id: ctx.agentId,
        request_id: callId,
        tool: approvalTarget,
        args: JSON.stringify(approvalArgs),
        result: 'hitl_granted',
      });
      return;
    }

    log.info(
      { agentId: ctx.agentId, event: eventName, mode },
      'Event subscription requires human approval'
    );

    const ticket = hitlEngine.create({
      agentId: ctx.agentId,
      tool: approvalTarget,
      args: approvalArgs,
      kind: 'call',
      mode: 'sync',
      subject,
    });

    const notification = hitlEngine.buildNotification(ticket.id);
    if (notification) hitlBatcher.add(notification);

    let result: Awaited<typeof ticket.result> | 'disconnected';
    if (ctx.signal && !ctx.signal.aborted) {
      let onAbort: (() => void) | undefined;
      result = await Promise.race([
        ticket.result,
        new Promise<'disconnected'>((resolve) => {
          onAbort = () => resolve('disconnected');
          ctx.signal!.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
      if (onAbort) ctx.signal.removeEventListener('abort', onAbort);
    } else if (ctx.signal?.aborted) {
      result = 'disconnected';
    } else {
      result = await ticket.result;
    }

    if (result === 'disconnected') {
      hitlBatcher.remove(ticket.id);
      hitlEngine.cancel(ticket.id);
      auditLogger.log({
        agent_id: ctx.agentId,
        request_id: callId,
        tool: approvalTarget,
        args: JSON.stringify(approvalArgs),
        result: 'hitl_disconnected',
      });
      throw createEventsError(
        EVENTS_ERROR_CODES.Forbidden,
        'Session disconnected while awaiting event subscription approval',
        { reason: 'hitl_disconnected' }
      );
    }

    if (result === 'denied') {
      auditLogger.log({
        agent_id: ctx.agentId,
        request_id: callId,
        tool: approvalTarget,
        args: JSON.stringify(approvalArgs),
        result: 'hitl_denied',
      });
      throw createEventsError(
        EVENTS_ERROR_CODES.Forbidden,
        'Event subscription denied by operator',
        { reason: 'hitl_denied' }
      );
    }

    if (result === 'timeout') {
      auditLogger.log({
        agent_id: ctx.agentId,
        request_id: callId,
        tool: approvalTarget,
        args: JSON.stringify(approvalArgs),
        result: 'hitl_timeout',
      });
      throw createEventsError(
        EVENTS_ERROR_CODES.Forbidden,
        'Event subscription approval timed out',
        { reason: 'hitl_timeout' }
      );
    }
  }
}

function pollLeaseKey(agentId: string, eventName: string, args: Record<string, unknown>): string {
  return `${agentId}\0${eventName}\0${stableStringify(args)}`;
}

function parsePollLeaseKey(key: string): [string, string, string] {
  const first = key.indexOf('\0');
  const second = first >= 0 ? key.indexOf('\0', first + 1) : -1;
  if (first < 0 || second < 0) return ['', '', '{}'];
  return [key.slice(0, first), key.slice(first + 1, second), key.slice(second + 1)];
}
