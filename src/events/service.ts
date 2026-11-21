import { randomBytes } from 'crypto';
import { isJsonContentType, type Notification } from '@modelcontextprotocol/server';
import type { AllowlistEngine } from '../allowlist/engine.js';
import type { AuditLogger } from '../audit/logger.js';
import type { AgentConfig } from '../config/schema.js';
import type { HitlBatcher } from '../hitl/batcher.js';
import type { HitlEngine } from '../hitl/engine.js';
import { fingerprintCall, type ApprovalSubject } from '../hitl/grants.js';
import { evaluateArgPolicy } from '../middleware/core/arg-policy.js';
import { generateId } from '../util/id.js';
import { stableStringify } from '../util/stable-json.js';
import { providerIdForTool } from '../util/tool-name.js';
import { childLogger } from '../util/logger.js';
import { inspectEventOccurrence } from './payload-inspector.js';
import { formatValidationErrors } from './schema-validator.js';
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
  EVENTS_NAMED_METHODS,
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

const POLL_LEASE_PREFIX = 'al_evt_';
const POLL_APPROVAL_MIN_STEP_TTL_MS = 60_000;
const POLL_APPROVAL_MAX_STEP_TTL_MS = 15 * 60_000;
const POLL_APPROVAL_MAX_LIFETIME_MS = 24 * 60 * 60_000;
const POLL_APPROVAL_MAX_ENTRIES = 10_000;
const MAX_HTTP_EVENT_BODY_BYTES = 4 * 1024 * 1024;
const MODERN_PROTOCOL_MIN_VERSION = '2026-07-28';

interface PollApprovalLease {
  agentId: string;
  sessionId?: string;
  eventName: string;
  argsKey: string;
  upstreamCursor: string;
  expiresAt: number;
  hardExpiresAt: number;
  /** Backing grant id, if approval came from a grant (checked live against revocation). */
  grantId?: string;
}

interface EventApprovalResult {
  grantId?: string;
  expiresAt?: number;
  /** False for capped-use (`maxUses`) grants so each poll consumes a use instead of minting a multi-poll lease. */
  allowLease: boolean;
}

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
   * Gateway-issued continuation tokens for approved `ask`-tier poll subscriptions.
   * Keyed by random opaque token (`al_evt_<hex>`) returned as the poll `cursor`, bound to
   * `(agentId, sessionId, eventName, canonicalArgs, upstreamCursor)` with bounded step TTL and
   * absolute lifetime cap. Never created until the upstream poll succeeds.
   */
  private readonly pollLeases = new Map<string, PollApprovalLease>();
  private readonly inFlightLeaseTokens = new Set<string>();
  private policyGeneration = 0;

  constructor(private readonly deps: EventServiceDeps) {}

  /**
   * Whether `io.modelcontextprotocol/events` should be advertised for this agent.
   */
  shouldAdvertiseFor(agentId: string, agentConfig: AgentConfig): boolean {
    if (this.deps.registry.hasEventsFor(agentId)) return true;
    const ev = agentConfig.events;
    return Boolean(ev && (ev.allow.length > 0 || ev.ask.length > 0));
  }

  /**
   * Look up an event's `inputSchema` for a specific agent (used by HTTP pre-dispatch `Mcp-Param-*`
   * validation). Returns `undefined` for denied events so `x-mcp-header` schemas are never leaked.
   */
  getEventInputSchemaForAgent(
    agentId: string,
    eventName: string
  ): Record<string, unknown> | undefined {
    if (this.deps.allowlist.evaluateEvent(agentId, eventName) === 'deny') return undefined;
    return this.deps.registry.getByName(eventName)?.descriptor.inputSchema;
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
    let { registered, decision } = this.authorizeAndValidate(
      ctx,
      callId,
      params.name,
      args,
      'poll'
    );

    const isGatewayCursor =
      typeof params.cursor === 'string' && params.cursor.startsWith(POLL_LEASE_PREFIX);
    if (isGatewayCursor && this.inFlightLeaseTokens.has(params.cursor!)) {
      throw createEventsError(
        EVENTS_ERROR_CODES.InvalidParams,
        'Event poll cursor is already in use by an in-flight poll request'
      );
    }

    let upstreamCursor: string | null | undefined = params.cursor;
    let hardExpiresAt = Date.now() + POLL_APPROVAL_MAX_LIFETIME_MS;
    let consumedLeaseToken: string | undefined;
    let backingGrantId: string | undefined;
    let allowContinuationLease = true;

    if (decision === 'ask') {
      const resolvedLease = this.matchPollLease(ctx, params.name, args, params.cursor);
      if (resolvedLease) {
        consumedLeaseToken = resolvedLease.token;
        this.inFlightLeaseTokens.add(consumedLeaseToken);
        upstreamCursor = resolvedLease.lease.upstreamCursor;
        hardExpiresAt = resolvedLease.lease.hardExpiresAt;
        backingGrantId = resolvedLease.lease.grantId;
      } else {
        // Never leak an internal `al_evt_*` token upstream if it expired, was revoked, or came
        // from another session. Only unwrap an expired token belonging to this exact binding.
        let fallbackCursor: string | null | undefined = upstreamCursor;
        if (isGatewayCursor) {
          fallbackCursor = this.unwrapSameBindingCursor(ctx, params.name, args, params.cursor!);
        }

        const approval = await this.requireApproval(ctx, callId, params.name, args, 'poll');
        allowContinuationLease = approval.allowLease;
        backingGrantId = approval.grantId;
        if (approval.expiresAt !== undefined) {
          hardExpiresAt = Math.min(hardExpiresAt, approval.expiresAt);
        }
        upstreamCursor = fallbackCursor;

        // Re-check live policy & catalog after awaiting human approval!
        const rechecked = this.authorizeAndValidate(
          this.withLiveAgentConfig(ctx),
          callId,
          params.name,
          args,
          'poll'
        );
        registered = rechecked.registered;
        decision = rechecked.decision;
      }
    } else if (isGatewayCursor) {
      // Event moved from `ask` -> `allow` while the client still holds a gateway lease cursor.
      // Unwrap matching binding to the upstream cursor, or reject unknown/mismatched tokens so
      // `al_evt_*` is never leaked to an upstream provider.
      const resolved = this.matchPollLease(ctx, params.name, args, params.cursor, {
        ignoreExpiry: true,
      });
      if (!resolved) {
        throw createEventsError(
          EVENTS_ERROR_CODES.InvalidParams,
          'Invalid or unrecognized gateway event cursor'
        );
      }
      consumedLeaseToken = resolved.token;
      this.inFlightLeaseTokens.add(consumedLeaseToken);
      upstreamCursor = resolved.lease.upstreamCursor;
    }

    const genBeforeUpstream = this.policyGeneration;
    const upstreamParams: EventsPollParams = {
      name: registered.upstreamName,
      ...(params.arguments !== undefined ? { arguments: params.arguments } : {}),
      ...(upstreamCursor !== undefined ? { cursor: upstreamCursor } : {}),
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
    } finally {
      if (consumedLeaseToken) {
        this.inFlightLeaseTokens.delete(consumedLeaseToken);
      }
    }

    // Re-check live policy if a config/catalog reload occurred while the upstream poll was in flight.
    if (this.policyGeneration !== genBeforeUpstream) {
      const revocation = this.checkLiveAccess(
        ctx.agentId,
        params.name,
        args,
        'poll',
        decision === 'ask'
      );
      if (revocation) {
        if (consumedLeaseToken) this.pollLeases.delete(consumedLeaseToken);
        throw createEventsError(revocation.code, revocation.message, revocation.data);
      }
    }

    const liveAgentConfig = this.deps.getAgentConfig(ctx.agentId) ?? ctx.agentConfig;
    const liveRegistered = this.deps.registry.getByName(params.name) ?? registered;
    const inspectedEvents = rawResult.events.map((occurrence) =>
      inspectEventOccurrence({
        agentId: ctx.agentId,
        agentConfig: liveAgentConfig,
        namespacedEventName: params.name,
        occurrence,
        auditLogger: this.deps.auditLogger,
        requestId: callId,
        validatePayload: liveRegistered.validatePayload,
      })
    );

    // Issue or rotate a gateway continuation cursor ONLY after upstream poll succeeds and returns
    // a non-null cursor (emit-only upstreams with `cursor: null` keep `cursor: null`).
    let deliveredCursor: string | null | undefined = rawResult.cursor;
    if (consumedLeaseToken) {
      this.pollLeases.delete(consumedLeaseToken);
    }
    if (
      decision === 'ask' &&
      allowContinuationLease &&
      typeof rawResult.cursor === 'string' &&
      (!backingGrantId || this.isGrantActive(ctx.agentId, backingGrantId))
    ) {
      const now = Date.now();
      const rawStepMs =
        typeof rawResult.nextPollMs === 'number' && Number.isFinite(rawResult.nextPollMs)
          ? Math.max(0, rawResult.nextPollMs) * 4
          : POLL_APPROVAL_MIN_STEP_TTL_MS;
      const boundedStepMs = Math.min(
        Math.max(rawStepMs, POLL_APPROVAL_MIN_STEP_TTL_MS),
        POLL_APPROVAL_MAX_STEP_TTL_MS
      );
      const expiresAt = Math.min(now + boundedStepMs, hardExpiresAt);
      if (expiresAt > now) {
        deliveredCursor = this.issuePollLease({
          agentId: ctx.agentId,
          sessionId: ctx.downstreamSessionId,
          eventName: params.name,
          argsKey: stableStringify(args),
          upstreamCursor: rawResult.cursor,
          expiresAt,
          hardExpiresAt,
          ...(backingGrantId ? { grantId: backingGrantId } : {}),
        });
      }
    }

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
      ...(deliveredCursor !== undefined ? { cursor: deliveredCursor } : {}),
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
    const initial = this.authorizeAndValidate(ctx, callId, params.name, args, 'push');
    let registered = initial.registered;
    const decision = initial.decision;

    // Never forward internal `al_evt_*` poll lease tokens upstream when handing off poll -> push.
    let streamCursor: string | null | undefined = params.cursor;
    if (typeof params.cursor === 'string' && params.cursor.startsWith(POLL_LEASE_PREFIX)) {
      const resolved = this.matchPollLease(ctx, params.name, args, params.cursor, {
        ignoreExpiry: true,
      });
      if (!resolved) {
        throw createEventsError(
          EVENTS_ERROR_CODES.InvalidParams,
          'Invalid or unrecognized gateway event cursor'
        );
      }
      streamCursor = resolved.lease.upstreamCursor;
    }

    const wasApproved = decision === 'ask';
    if (wasApproved) {
      await this.requireApproval(ctx, callId, params.name, args, 'push');
      // Re-check live policy & catalog after awaiting human approval!
      const rechecked = this.authorizeAndValidate(
        this.withLiveAgentConfig(ctx),
        callId,
        params.name,
        args,
        'push'
      );
      registered = rechecked.registered;
    }

    const subscriptionMeta = { [SUBSCRIPTION_ID_META_KEY]: ctx.requestId };
    const streamAbort = new AbortController();
    const onCallerAbort = () => streamAbort.abort(ctx.signal?.reason);
    if (ctx.signal) {
      if (ctx.signal.aborted) {
        throw createEventsError(EVENTS_ERROR_CODES.Forbidden, 'Stream aborted before opening');
      }
      ctx.signal.addEventListener('abort', onCallerAbort, { once: true });
    }

    let terminatedByGateway = false;
    let activeSent = false;
    let pendingTerminationError: EventStreamErrorObject | undefined;

    const emitDownstream = async (method: string, notifParams: Record<string, unknown>) => {
      if (streamAbort.signal.aborted && method !== EVENT_NOTIFICATIONS.terminated) return;
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
          streamAbort.abort();
        });
    };

    // Atomically reserve a stream slot BEFORE calling upstream so concurrent opens cannot bypass
    // per-agent/global limits and config reloads can immediately cancel pending opens!
    try {
      this.deps.streamManager.reserve({
        id: callId,
        agentId: ctx.agentId,
        eventName: params.name,
        args,
        approved: wasApproved,
        terminate: async (error: EventStreamErrorObject) => {
          if (terminatedByGateway) return;
          terminatedByGateway = true;
          pendingTerminationError = error;
          if (activeSent) {
            await emitDownstream(EVENT_NOTIFICATIONS.terminated, { error });
          }
          streamAbort.abort(createEventsError(error.code, error.message, error.data));
        },
        closeGracefully: () => {
          streamAbort.abort();
          return Promise.resolve();
        },
      });
    } catch (err) {
      ctx.signal?.removeEventListener('abort', onCallerAbort);
      throw err;
    }

    let lastCheckedGen = this.policyGeneration;
    let upstreamHandle: UpstreamEventStreamHandle | undefined;
    const startedAt = Date.now();

    try {
      const upstreamParams: EventsStreamParams = {
        name: registered.upstreamName,
        ...(params.arguments !== undefined ? { arguments: params.arguments } : {}),
        ...(streamCursor !== undefined ? { cursor: streamCursor } : {}),
        ...(params.maxAgeMs !== undefined ? { maxAgeMs: params.maxAgeMs } : {}),
        ...(params.heartbeatMs !== undefined ? { heartbeatMs: params.heartbeatMs } : {}),
      };

      upstreamHandle = await this.deps.pool.openEventStream(
        registered.providerId,
        upstreamParams,
        {
          // Serialized on EventsAwareClient's queue BEFORE any onEvent callback can run!
          onActive: async (active) => {
            if (terminatedByGateway || streamAbort.signal.aborted) return;
            activeSent = true;
            await emitDownstream(EVENT_NOTIFICATIONS.active, {
              ...(active.cursor !== undefined ? { cursor: active.cursor } : {}),
              ...(active.truncated !== undefined ? { truncated: active.truncated } : {}),
              ...(active.heartbeatMs !== undefined ? { heartbeatMs: active.heartbeatMs } : {}),
            });
          },
          onEvent: async (occurrence) => {
            if (terminatedByGateway || streamAbort.signal.aborted) return;
            if (this.policyGeneration !== lastCheckedGen) {
              lastCheckedGen = this.policyGeneration;
              const revocation = this.checkLiveAccess(
                ctx.agentId,
                params.name,
                args,
                'push',
                wasApproved
              );
              if (revocation) {
                terminatedByGateway = true;
                await emitDownstream(EVENT_NOTIFICATIONS.terminated, { error: revocation });
                streamAbort.abort();
                await upstreamHandle?.close();
                return;
              }
            }
            const liveAgentConfig = this.deps.getAgentConfig(ctx.agentId) ?? ctx.agentConfig;
            const liveRegistered = this.deps.registry.getByName(params.name) ?? registered;
            const inspected = inspectEventOccurrence({
              agentId: ctx.agentId,
              agentConfig: liveAgentConfig,
              namespacedEventName: params.name,
              occurrence,
              auditLogger: this.deps.auditLogger,
              requestId: callId,
              validatePayload: liveRegistered.validatePayload,
            });
            await emitDownstream(EVENT_NOTIFICATIONS.event, inspected);
          },
          onHeartbeat: async (hb) => {
            if (terminatedByGateway || streamAbort.signal.aborted) return;
            await emitDownstream(EVENT_NOTIFICATIONS.heartbeat, {
              ...(hb.cursor !== undefined ? { cursor: hb.cursor } : {}),
            });
          },
          onError: async (errParams) => {
            if (terminatedByGateway || streamAbort.signal.aborted) return;
            await emitDownstream(EVENT_NOTIFICATIONS.error, { error: errParams.error });
          },
          onTerminated: async (termParams) => {
            if (terminatedByGateway) return;
            terminatedByGateway = true;
            await emitDownstream(EVENT_NOTIFICATIONS.terminated, { error: termParams.error });
          },
        },
        {
          signal: streamAbort.signal,
          inputSchema: registered.descriptor.inputSchema,
        }
      );

      // If policy revocation landed during the open/active window, tear down immediately so a
      // revoked stream never completes cleanly without error or termination.
      if (terminatedByGateway) {
        await upstreamHandle.close();
        if (!activeSent && pendingTerminationError) {
          throw createEventsError(
            pendingTerminationError.code,
            pendingTerminationError.message,
            pendingTerminationError.data
          );
        }
        return {
          resultType: 'complete',
          _meta: subscriptionMeta,
        };
      }

      // Upgrade handlers so live revocation/shutdown tears down the open upstream handle cleanly.
      const handle = upstreamHandle;
      this.deps.streamManager.updateHandlers(callId, {
        terminate: async (error: EventStreamErrorObject) => {
          if (terminatedByGateway) return;
          terminatedByGateway = true;
          pendingTerminationError = error;
          if (activeSent) {
            await emitDownstream(EVENT_NOTIFICATIONS.terminated, { error });
          }
          streamAbort.abort();
          await handle.close();
        },
        closeGracefully: async () => {
          streamAbort.abort();
          await handle.close();
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

      const outcome = await handle.closed;
      // Distinguish abnormal upstream EOF/disconnect/overflow from a clean graceful close:
      // per SEP-3415, `notifications/events/terminated` signals terminal closure with error,
      // whereas `notifications/events/error` is non-terminal.
      if (outcome.cause === 'remote' && !terminatedByGateway && !streamAbort.signal.aborted) {
        const errObj: EventStreamErrorObject = {
          code: -32603,
          message: outcome.error?.message ?? 'Upstream event stream closed unexpectedly',
          data: { reason: 'upstream_closed' },
        };
        if (!activeSent) {
          throw createEventsError(errObj.code, errObj.message, errObj.data);
        }
        terminatedByGateway = true;
        await emitDownstream(EVENT_NOTIFICATIONS.terminated, { error: errObj });
      }

      return {
        resultType: 'complete',
        _meta: subscriptionMeta,
      };
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
      if (pendingTerminationError) {
        throw createEventsError(
          pendingTerminationError.code,
          pendingTerminationError.message,
          pendingTerminationError.data
        );
      }
      throw err;
    } finally {
      this.deps.streamManager.release(callId);
      ctx.signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  handleUnsupportedWebhook(
    ctx: EventRequestContext,
    eventName: string,
    args: Record<string, unknown> = {}
  ): never {
    const decision = this.deps.allowlist.evaluateEvent(ctx.agentId, eventName);
    validateEventRoutingHeaders(
      ctx.httpReq,
      eventName,
      args,
      decision === 'deny'
        ? undefined
        : this.deps.registry.getByName(eventName)?.descriptor.inputSchema
    );
    this.deps.auditLogger.log({
      agent_id: ctx.agentId,
      request_id: generateId(),
      tool: `event:${eventName}`,
      args: JSON.stringify(args),
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
   * Re-evaluate every reserved/open stream and poll lease after a config or catalog reload.
   * Revoked or schema-broken streams receive `notifications/events/terminated` with `Forbidden`
   * (`-32024`), `NotFound` (`-32023`), or `Unsupported` (`-32026`) per SEP-3415.
   */
  async reconcileAfterReload(): Promise<void> {
    this.policyGeneration += 1;
    const now = Date.now();

    for (const [token, lease] of this.pollLeases) {
      if (lease.expiresAt <= now || lease.hardExpiresAt <= now) {
        this.pollLeases.delete(token);
        continue;
      }
      let parsedArgs: Record<string, unknown>;
      try {
        parsedArgs = JSON.parse(lease.argsKey) as Record<string, unknown>;
      } catch {
        this.pollLeases.delete(token);
        continue;
      }
      if (
        this.checkLiveAccess(lease.agentId, lease.eventName, parsedArgs, 'poll', true) !== undefined
      ) {
        this.pollLeases.delete(token);
      }
    }

    await this.deps.streamManager.revokeDisallowed(({ agentId, eventName, args, approved }) =>
      this.checkLiveAccess(agentId, eventName, args, 'push', approved)
    );
  }

  private withLiveAgentConfig(ctx: EventRequestContext): EventRequestContext {
    const live = this.deps.getAgentConfig(ctx.agentId);
    return live ? { ...ctx, agentConfig: live } : ctx;
  }

  private checkLiveAccess(
    agentId: string,
    eventName: string,
    args: Record<string, unknown>,
    mode: 'poll' | 'push',
    wasApproved: boolean
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
    if (decision === 'ask' && !wasApproved) {
      return {
        code: EVENTS_ERROR_CODES.Forbidden,
        message: 'Forbidden',
        data: { reason: 'Approval now required' },
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

    if (!registered.descriptor.delivery.includes(mode)) {
      return {
        code: EVENTS_ERROR_CODES.Unsupported,
        message: 'Unsupported',
        data: { feature: 'deliveryMode', value: mode },
      };
    }

    // Per SEP-3415: purely additive inputSchema changes keep existing subscriptions alive;
    // breaking changes where current `arguments` no longer validate terminate with Unsupported.
    if (registered.validateInput && !registered.validateInput(args)) {
      return {
        code: EVENTS_ERROR_CODES.Unsupported,
        message: 'Unsupported',
        data: { feature: 'inputSchema', reason: 'schema_changed' },
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

    // Validate routing headers (defense-in-depth alongside HTTP pre-dispatch validation).
    // Never pass a denied event's inputSchema (prevents leaking x-mcp-header annotations).
    validateEventRoutingHeaders(
      ctx.httpReq,
      eventName,
      args,
      decision === 'deny' ? undefined : registered?.descriptor.inputSchema
    );

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

    if (registered.validateInput && !registered.validateInput(args)) {
      const errors = formatValidationErrors(registered.validateInput);
      throw createEventsError(
        EVENTS_ERROR_CODES.InvalidParams,
        `Invalid subscription arguments for ${eventName}: ${errors}`
      );
    }

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

  private isGrantActive(agentId: string, grantId: string): boolean {
    return this.deps.hitlEngine.listGrants(agentId).some((g) => g.id === grantId);
  }

  private matchPollLease(
    ctx: EventRequestContext,
    eventName: string,
    args: Record<string, unknown>,
    cursor: string | null | undefined,
    options?: { ignoreExpiry?: boolean }
  ): { token: string; lease: PollApprovalLease } | undefined {
    if (typeof cursor !== 'string' || !cursor.startsWith(POLL_LEASE_PREFIX)) return undefined;
    const lease = this.pollLeases.get(cursor);
    if (!lease) return undefined;

    if (
      lease.agentId !== ctx.agentId ||
      lease.sessionId !== ctx.downstreamSessionId ||
      lease.eventName !== eventName ||
      lease.argsKey !== stableStringify(args)
    ) {
      return undefined;
    }

    if (!options?.ignoreExpiry) {
      const now = Date.now();
      if (lease.expiresAt <= now || lease.hardExpiresAt <= now) {
        this.pollLeases.delete(cursor);
        return undefined;
      }
      if (lease.grantId && !this.isGrantActive(ctx.agentId, lease.grantId)) {
        this.pollLeases.delete(cursor);
        return undefined;
      }
    }

    return { token: cursor, lease };
  }

  /**
   * If a client presented an expired/revoked `al_evt_*` cursor belonging to THIS exact
   * `(agentId, sessionId, eventName, args)` binding, unwrap its upstream cursor after fresh
   * approval so the internal `al_evt_*` token is never forwarded upstream. For unknown or
   * cross-session tokens, reset to `null` (never leak `al_evt_*` or another session's cursor).
   */
  private unwrapSameBindingCursor(
    ctx: EventRequestContext,
    eventName: string,
    args: Record<string, unknown>,
    cursor: string
  ): string | null {
    const lease = this.pollLeases.get(cursor);
    if (
      lease &&
      lease.agentId === ctx.agentId &&
      lease.sessionId === ctx.downstreamSessionId &&
      lease.eventName === eventName &&
      lease.argsKey === stableStringify(args)
    ) {
      this.pollLeases.delete(cursor);
      return lease.upstreamCursor;
    }
    return null;
  }

  private issuePollLease(lease: PollApprovalLease): string {
    const token = `${POLL_LEASE_PREFIX}${randomBytes(16).toString('hex')}`;
    if (this.pollLeases.size >= POLL_APPROVAL_MAX_ENTRIES) {
      const oldest = this.pollLeases.keys().next().value;
      if (oldest !== undefined) this.pollLeases.delete(oldest);
    }
    this.pollLeases.set(token, lease);
    return token;
  }

  /** Returns approval grant metadata so poll leases honor grant lifetime, revocation, and use caps. */
  private async requireApproval(
    ctx: EventRequestContext,
    callId: string,
    eventName: string,
    args: Record<string, unknown>,
    mode: 'poll' | 'push'
  ): Promise<EventApprovalResult> {
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
      return {
        grantId: grant.id,
        expiresAt: grant.expiresAt ? Date.parse(grant.expiresAt) : undefined,
        // Capped-use grants (e.g. maxUses: 1) must consume a use per poll rather than minting an
        // unbounded multi-poll continuation lease.
        allowLease: grant.usesRemaining === undefined,
      };
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

    // If the operator approved with a time/use-bounded grant, propagate its expiry/revocation.
    const createdGrant = hitlEngine.listGrants(ctx.agentId).find((g) => g.approvalId === ticket.id);
    if (createdGrant) {
      return {
        grantId: createdGrant.id,
        expiresAt: createdGrant.expiresAt ? Date.parse(createdGrant.expiresAt) : undefined,
        allowLease: createdGrant.usesRemaining === undefined,
      };
    }

    return { allowLease: true };
  }
}

async function readBoundedJsonBody(webReq: Request, maxBytes: number): Promise<unknown> {
  const contentLength = webReq.headers.get('content-length');
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      return undefined;
    }
  }

  let cloned: Request;
  try {
    cloned = webReq.clone();
  } catch {
    return undefined;
  }

  const bodyStream = cloned.body as ReadableStream<Uint8Array> | null;
  const reader = bodyStream?.getReader();
  if (!reader) return undefined;

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value = chunk.value;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8').decode(combined));
  } catch {
    return undefined;
  }
}

/**
 * Pre-dispatch HTTP routing header validation for SEP-3415 named `events/*` requests
 * (`events/poll`, `events/stream`, `events/subscribe`, `events/unsubscribe`).
 *
 * Runs BEFORE `createMcpHandler` opens an SSE response so missing or mismatched `Mcp-Name` /
 * `Mcp-Param-*` headers return HTTP `400 Bad Request` with JSON-RPC `-32020 HeaderMismatch` as
 * required by SEP-3415 & SEP-2243, while deferring non-JSON (415), >4 MiB (413), legacy-era,
 * and missing-envelope requests to the SDK's own inbound ladder.
 */
export async function validateHttpEventRoutingHeaders(
  webReq: Request,
  getInputSchema: (eventName: string) => Record<string, unknown> | undefined
): Promise<Response | undefined> {
  if (webReq.method !== 'POST') return undefined;
  if (!isJsonContentType(webReq.headers.get('content-type'))) return undefined;
  const mcpMethod = webReq.headers.get('mcp-method');
  if (!mcpMethod || !EVENTS_NAMED_METHODS.has(mcpMethod)) return undefined;
  const protocolVersion = webReq.headers.get('mcp-protocol-version');
  if (!protocolVersion || protocolVersion < MODERN_PROTOCOL_MIN_VERSION) return undefined;

  const body = await readBoundedJsonBody(webReq, MAX_HTTP_EVENT_BODY_BYTES);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const reqObj = body as { id?: unknown; method?: unknown; params?: unknown };
  if (reqObj.method !== mcpMethod) return undefined; // Let SDK's Mcp-Method check handle it.
  if (!reqObj.params || typeof reqObj.params !== 'object' || Array.isArray(reqObj.params)) {
    return undefined;
  }
  const params = reqObj.params as { name?: unknown; arguments?: unknown; _meta?: unknown };
  // Defer requests missing the 2026-07-28 `_meta` envelope to the SDK's own `-32602` ladder.
  if (!params._meta || typeof params._meta !== 'object' || Array.isArray(params._meta)) {
    return undefined;
  }
  if (typeof params.name !== 'string' || params.name.length === 0) return undefined;
  const args =
    params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? (params.arguments as Record<string, unknown>)
      : {};

  try {
    validateEventRoutingHeaders(webReq, params.name, args, getInputSchema(params.name), {
      requireHeaders: true,
    });
    return undefined;
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err && typeof err.code === 'number'
        ? err.code
        : EVENTS_ERROR_CODES.HeaderMismatch;
    const message = err instanceof Error ? err.message : 'HeaderMismatch';
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: typeof reqObj.id === 'string' || typeof reqObj.id === 'number' ? reqObj.id : null,
        error: { code, message },
      }),
      {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }
    );
  }
}
