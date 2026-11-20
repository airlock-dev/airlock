import {
  Client,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  type ClientOptions,
  type Implementation,
  type JSONRPCErrorResponse,
  type JSONRPCNotification,
  type JSONRPCRequest,
  type JSONRPCResponse,
  type MessageExtraInfo,
} from '@modelcontextprotocol/client';
import {
  EVENT_METHODS,
  EVENT_NOTIFICATIONS,
  EVENTS_EXTENSION_ID,
  EVENTS_NAMED_METHODS,
  SUBSCRIPTION_ID_META_KEY,
  EventsListResultSchema,
  EventsPollResultSchema,
  EventOccurrenceSchema,
  EventStreamActiveParamsSchema,
  EventStreamErrorParamsSchema,
  EventStreamHeartbeatParamsSchema,
  EventStreamTerminatedParamsSchema,
  buildEventParamHeaders,
  encodeMcpHeaderValue,
  type EventDescriptor,
  type EventOccurrence,
  type EventStreamActiveParams,
  type EventStreamErrorParams,
  type EventStreamHeartbeatParams,
  type EventStreamTerminatedParams,
  type EventsPollParams,
  type EventsPollResult,
  type EventsStreamParams,
} from './protocol.js';

const MAX_EVENT_LIST_PAGES = 50;
const DEFAULT_STREAM_ACK_TIMEOUT_MS = 30_000;
/** Max buffered notifications per stream before dropping a stalled consumer. */
const MAX_QUEUED_STREAM_NOTIFICATIONS = 256;

export interface UpstreamEventStreamCallbacks {
  /**
   * Invoked strictly in-order on the initial `notifications/events/active` confirmation (BEFORE any
   * `onEvent` callback runs) as well as on mid-stream gap confirmations (`truncated: true`).
   */
  onActive?: (params: EventStreamActiveParams) => void | Promise<void>;
  onEvent: (occurrence: EventOccurrence) => void | Promise<void>;
  onHeartbeat?: (params: EventStreamHeartbeatParams) => void | Promise<void>;
  onError?: (params: EventStreamErrorParams) => void | Promise<void>;
  onTerminated?: (params: EventStreamTerminatedParams) => void | Promise<void>;
}

export interface UpstreamEventStreamOptions {
  signal?: AbortSignal;
  ackTimeoutMs?: number;
  inputSchema?: Record<string, unknown>;
}

export interface UpstreamEventStreamHandle {
  /** Initial `notifications/events/active` payload from the upstream server. */
  active: EventStreamActiveParams;
  /** Resolves when the stream finishes (graceful close, termination, abort, or disconnect). */
  closed: Promise<{ cause: 'local' | 'graceful' | 'terminated' | 'remote'; error?: Error }>;
  /** Cancel and tear down the upstream stream. */
  close: () => Promise<void>;
}

interface StreamState {
  callbacks: UpstreamEventStreamCallbacks;
  ackReceived: boolean;
  chain: Promise<void>;
  queuedCount: number;
  enqueue: (fn: () => void | Promise<void>) => void;
  onActive: (params: EventStreamActiveParams) => void;
  settle: (outcome: {
    cause: 'local' | 'graceful' | 'terminated' | 'remote';
    error?: Error;
  }) => void;
}

/**
 * MCP Client subclass with first-class SEP-3415 Events (`io.modelcontextprotocol/events`) support.
 *
 * Uses the SDK's protected `_onnotification` / `_onresponse` / `_onclose` hooks (the same mechanism
 * `Client.listen()` uses for `subscriptions/listen`) so long-lived `events/stream` requests can be
 * correlated by string JSON-RPC IDs (`airlock-events:N`) without colliding with numeric request IDs
 * or hitting the SDK's default 60-second request timeout.
 */
export class EventsAwareClient extends Client {
  private readonly eventStreams = new Map<string, StreamState>();
  private readonly listChangedListeners = new Set<() => void>();
  private nextEventStreamId = 0;

  constructor(clientInfo: Implementation, options?: ClientOptions) {
    const existingCapabilities = options?.capabilities ?? {};
    const existingExtensions =
      (existingCapabilities as { extensions?: Record<string, Record<string, unknown>> })
        .extensions ?? {};
    super(clientInfo, {
      ...options,
      capabilities: {
        ...existingCapabilities,
        extensions: {
          ...existingExtensions,
          [EVENTS_EXTENSION_ID]: {},
        },
      },
    });
  }

  /** Subscribe to upstream `notifications/events/list_changed` notifications. */
  onEventsListChanged(listener: () => void): () => void {
    this.listChangedListeners.add(listener);
    return () => this.listChangedListeners.delete(listener);
  }

  /** Whether the connected upstream server advertised `io.modelcontextprotocol/events`. */
  supportsEvents(): boolean {
    const caps = this.getServerCapabilities() as
      | { extensions?: Record<string, unknown> }
      | undefined;
    return Boolean(caps?.extensions && EVENTS_EXTENSION_ID in caps.extensions);
  }

  /** Whether the upstream advertised `listChanged: true` for events. */
  supportsEventsListChanged(): boolean {
    const caps = this.getServerCapabilities() as
      | { extensions?: Record<string, unknown> }
      | undefined;
    const ext = caps?.extensions?.[EVENTS_EXTENSION_ID];
    return (
      typeof ext === 'object' &&
      ext !== null &&
      (ext as { listChanged?: unknown }).listChanged === true
    );
  }

  /**
   * Explicitly settle all open `events/stream` handles (e.g. before replacing a transport during
   * OAuth or session recovery where `transport.onclose` is detached to suppress auto-reconnect).
   */
  closeEventStreams(reason = 'events/stream: upstream connection replaced'): void {
    if (this.eventStreams.size === 0) return;
    const err = new SdkError(SdkErrorCode.ConnectionClosed, reason);
    for (const entry of Array.from(this.eventStreams.values())) {
      entry.settle({ cause: 'remote', error: err });
    }
  }

  /** List all event types advertised by the upstream server, following pagination cursors. */
  async listEvents(options?: {
    timeout?: number;
    signal?: AbortSignal;
  }): Promise<EventDescriptor[]> {
    if (!this.supportsEvents()) return [];
    const events: EventDescriptor[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MAX_EVENT_LIST_PAGES; page++) {
      const result = await this.request(
        {
          method: EVENT_METHODS.list,
          params: cursor ? { cursor } : {},
        },
        EventsListResultSchema,
        options
      );
      events.push(...result.events);
      if (!result.nextCursor || result.nextCursor === cursor) break;
      cursor = result.nextCursor;
    }

    return events;
  }

  /** Poll one subscription on the upstream server (`events/poll`). */
  async pollEvents(
    params: EventsPollParams,
    options?: { timeout?: number; signal?: AbortSignal; inputSchema?: Record<string, unknown> }
  ): Promise<EventsPollResult> {
    const paramHeaders = buildEventParamHeaders(params.arguments, options?.inputSchema);
    return this.request(
      {
        method: EVENT_METHODS.poll,
        params: stripUndefined(params),
      },
      EventsPollResultSchema,
      {
        timeout: options?.timeout,
        signal: options?.signal,
        ...(Object.keys(paramHeaders).length > 0 ? { headers: paramHeaders } : {}),
      }
    );
  }

  /**
   * Open a long-lived `events/stream` subscription on the upstream server.
   *
   * Serializes the initial `notifications/events/active` callback BEFORE every subsequent event,
   * heartbeat, error, or termination callback on the stream's ordered delivery queue, so a fast
   * burst of `active` + `event` frames can never deliver an event before `active`.
   */
  async openEventStream(
    params: EventsStreamParams,
    callbacks: UpstreamEventStreamCallbacks,
    options: UpstreamEventStreamOptions = {}
  ): Promise<UpstreamEventStreamHandle> {
    const transport = this.transport;
    if (!transport) {
      throw new SdkError(SdkErrorCode.NotConnected, 'Not connected');
    }

    if (options.signal?.aborted) {
      throw toAbortError(options.signal.reason);
    }

    const streamId = `airlock-events:${this.nextEventStreamId++}`;
    const requestAbort = new AbortController();

    let settled = false;
    let acked = false;
    let activeResolved = false;
    let droppingQueued = false;
    let ackTimer: ReturnType<typeof setTimeout> | undefined;
    let onCallerAbort: (() => void) | undefined;

    let resolveActive!: (active: EventStreamActiveParams) => void;
    let rejectActive!: (err: Error) => void;
    const activePromise = new Promise<EventStreamActiveParams>((resolve, reject) => {
      resolveActive = resolve;
      rejectActive = reject;
    });

    let resolveClosed!: (outcome: {
      cause: 'local' | 'graceful' | 'terminated' | 'remote';
      error?: Error;
    }) => void;
    const closedPromise = new Promise<{
      cause: 'local' | 'graceful' | 'terminated' | 'remote';
      error?: Error;
    }>((resolve) => {
      resolveClosed = resolve;
    });

    const clearAckTimer = () => {
      if (ackTimer !== undefined) {
        clearTimeout(ackTimer);
        ackTimer = undefined;
      }
    };

    const wireTeardown = async () => {
      requestAbort.abort();
      await this.notification({
        method: 'notifications/cancelled',
        params: { requestId: streamId },
      }).catch(() => {});
    };

    const settle = (
      outcome: {
        cause: 'local' | 'graceful' | 'terminated' | 'remote';
        error?: Error;
      },
      opts?: { dropQueued?: boolean }
    ) => {
      if (settled) return;
      settled = true;
      if (opts?.dropQueued) {
        droppingQueued = true;
      }
      clearAckTimer();
      if (onCallerAbort) {
        options.signal?.removeEventListener('abort', onCallerAbort);
      }
      const entry = this.eventStreams.get(streamId);
      this.eventStreams.delete(streamId);
      requestAbort.abort();

      const finish = () => {
        if (!activeResolved) {
          activeResolved = true;
          rejectActive(
            outcome.error ??
              new SdkError(
                SdkErrorCode.ConnectionClosed,
                'events/stream closed before upstream confirmed active'
              )
          );
        }
        resolveClosed(outcome);
      };

      if (entry && !droppingQueued) {
        void entry.chain.finally(finish);
      } else {
        finish();
      }
    };

    const close = async () => {
      if (settled) return;
      settle({ cause: 'local' }, { dropQueued: true });
      await wireTeardown();
    };

    const state: StreamState = {
      callbacks,
      ackReceived: false,
      chain: Promise.resolve(),
      queuedCount: 0,
      enqueue(fn) {
        if (droppingQueued) return;
        if (state.queuedCount >= MAX_QUEUED_STREAM_NOTIFICATIONS) {
          settle(
            {
              cause: 'remote',
              error: new Error(
                `events/stream notification buffer exceeded (${MAX_QUEUED_STREAM_NOTIFICATIONS})`
              ),
            },
            { dropQueued: true }
          );
          void wireTeardown();
          return;
        }
        state.queuedCount += 1;
        state.chain = state.chain
          .then(() => {
            if (droppingQueued) return undefined;
            return fn();
          })
          .catch(() => {})
          .finally(() => {
            state.queuedCount = Math.max(0, state.queuedCount - 1);
          });
      },
      onActive: (active) => {
        clearAckTimer();
        const firstAck = !acked;
        acked = true;
        state.ackReceived = true;
        // Enqueue `onActive` onto the SAME ordered queue as `onEvent` so the downstream client
        // ALWAYS receives `notifications/events/active` strictly before any event frame, and
        // resolve `activePromise` only after `callbacks.onActive` completes so callers never race
        // `updateHandlers()` or policy revocation against an unsent `active` notification.
        state.enqueue(async () => {
          await callbacks.onActive?.(active);
          if (firstAck && !activeResolved) {
            activeResolved = true;
            resolveActive(active);
          }
        });
      },
      settle,
    };

    this.eventStreams.set(streamId, state);

    const ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_STREAM_ACK_TIMEOUT_MS;
    ackTimer = setTimeout(() => {
      settle(
        {
          cause: 'remote',
          error: new SdkError(SdkErrorCode.RequestTimeout, 'events/stream confirmation timed out', {
            timeout: ackTimeoutMs,
          }),
        },
        { dropQueued: true }
      );
      void wireTeardown();
    }, ackTimeoutMs);
    ackTimer.unref?.();

    if (options.signal) {
      const callerSignal = options.signal;
      onCallerAbort = () => {
        if (settled) return;
        settle(
          {
            cause: 'local',
            error: toAbortError(callerSignal.reason),
          },
          { dropQueued: true }
        );
        void wireTeardown();
      };
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }

    const envelope = this._outboundMetaEnvelope();
    const requestParams: Record<string, unknown> = {
      ...stripUndefined(params),
      ...(envelope
        ? {
            _meta: {
              ...envelope,
              ...(params._meta ?? {}),
            },
          }
        : {}),
    };

    const jsonrpcRequest: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: streamId,
      method: EVENT_METHODS.stream,
      params: requestParams,
    };

    const paramHeaders = buildEventParamHeaders(params.arguments, options.inputSchema);
    const routeSendFailure = (err: unknown) => {
      settle({
        cause: 'remote',
        error: err instanceof Error ? err : new Error(String(err)),
      });
    };

    try {
      void transport
        .send(jsonrpcRequest, {
          requestSignal: requestAbort.signal,
          ...(Object.keys(paramHeaders).length > 0 ? { headers: paramHeaders } : {}),
          onRequestStreamEnd: () =>
            settle({
              cause: 'remote',
              error: new Error('events/stream: upstream stream ended'),
            }),
        } as Parameters<typeof transport.send>[1])
        .catch(routeSendFailure);
    } catch (err) {
      routeSendFailure(err);
    }

    const active = await activePromise;
    return { active, closed: closedPromise, close };
  }

  protected override _onnotification(raw: JSONRPCNotification, extra?: MessageExtraInfo): void {
    const method = raw.method;
    if (method === EVENT_NOTIFICATIONS.listChanged) {
      for (const listener of this.listChangedListeners) {
        try {
          listener();
        } catch {
          // best effort
        }
      }
      return;
    }

    if (
      method === EVENT_NOTIFICATIONS.active ||
      method === EVENT_NOTIFICATIONS.event ||
      method === EVENT_NOTIFICATIONS.heartbeat ||
      method === EVENT_NOTIFICATIONS.error ||
      method === EVENT_NOTIFICATIONS.terminated
    ) {
      const rawParams =
        raw.params && typeof raw.params === 'object'
          ? (raw.params as Record<string, unknown>)
          : undefined;
      const meta =
        rawParams?._meta && typeof rawParams._meta === 'object'
          ? (rawParams._meta as Record<string, unknown>)
          : undefined;
      const subId = meta?.[SUBSCRIPTION_ID_META_KEY];
      const entry = typeof subId === 'string' ? this.eventStreams.get(subId) : undefined;

      if (entry) {
        this.dispatchEventNotification(entry, method, rawParams ?? {});
        return;
      }
    }

    super._onnotification(raw, extra);
  }

  private dispatchEventNotification(
    entry: StreamState,
    method: string,
    rawParams: Record<string, unknown>
  ): void {
    if (method === EVENT_NOTIFICATIONS.active) {
      const parsed = EventStreamActiveParamsSchema.safeParse(rawParams);
      if (parsed.success) {
        entry.onActive(parsed.data);
      }
      return;
    }

    if (method === EVENT_NOTIFICATIONS.event) {
      const parsed = EventOccurrenceSchema.safeParse(rawParams);
      if (parsed.success) {
        entry.enqueue(() => entry.callbacks.onEvent(parsed.data));
      }
      return;
    }

    if (method === EVENT_NOTIFICATIONS.heartbeat) {
      const parsed = EventStreamHeartbeatParamsSchema.safeParse(rawParams);
      if (parsed.success) {
        entry.enqueue(() => entry.callbacks.onHeartbeat?.(parsed.data));
      }
      return;
    }

    if (method === EVENT_NOTIFICATIONS.error) {
      const parsed = EventStreamErrorParamsSchema.safeParse(rawParams);
      if (parsed.success) {
        entry.enqueue(() => entry.callbacks.onError?.(parsed.data));
      }
      return;
    }

    if (method === EVENT_NOTIFICATIONS.terminated) {
      const parsed = EventStreamTerminatedParamsSchema.safeParse(rawParams);
      if (parsed.success) {
        const terminated = parsed.data;
        entry.enqueue(() => entry.callbacks.onTerminated?.(terminated));
        entry.settle({
          cause: 'terminated',
          error: ProtocolError.fromError(
            terminated.error.code,
            terminated.error.message,
            terminated.error.data
          ),
        });
      } else {
        entry.settle({ cause: 'terminated' });
      }
    }
  }

  protected override _onresponse(response: JSONRPCResponse | JSONRPCErrorResponse): void {
    const id = response.id;
    const entry = typeof id === 'string' ? this.eventStreams.get(id) : undefined;
    if (entry) {
      if ('error' in response && response.error) {
        entry.settle({
          cause: 'remote',
          error: ProtocolError.fromError(
            response.error.code,
            response.error.message,
            response.error.data
          ),
        });
      } else {
        entry.settle({ cause: 'graceful' });
      }
      return;
    }
    super._onresponse(response);
  }

  protected override _onclose(): void {
    this.closeEventStreams('events/stream: upstream connection closed');
    super._onclose();
  }
}

/**
 * Wrap a `fetch` function for `StreamableHTTPClientTransport` so outgoing SEP-3415 `events/*`
 * requests always carry the canonical `Mcp-Name` routing header derived from `params.name`.
 *
 * SDK v2.3.1's `StreamableHTTPClientTransport` does not yet include `events/*` in its built-in
 * `MCP_NAME_HEADER_SOURCE` table and strips `mcp-name` from per-request `options.headers`, so
 * setting `Mcp-Name` unconditionally at the fetch seam guarantees full SEP-3415 wire compliance
 * (even overriding any stale preconfigured `Mcp-Name` header).
 */
export function wrapFetchWithEventHeaders(
  baseFetch?: (url: string | URL, init?: RequestInit) => Promise<Response>
): (url: string | URL, init?: RequestInit) => Promise<Response> {
  return (url, init) => {
    const delegate = baseFetch ?? globalThis.fetch;
    if (init?.method?.toUpperCase() === 'POST' && typeof init.body === 'string') {
      const headers = new Headers(init.headers);
      const mcpMethod = headers.get('mcp-method');
      if (mcpMethod && EVENTS_NAMED_METHODS.has(mcpMethod)) {
        try {
          const body = JSON.parse(init.body) as { params?: { name?: unknown } };
          if (typeof body?.params?.name === 'string' && body.params.name.length > 0) {
            headers.set('mcp-name', encodeMcpHeaderValue(body.params.name));
            return delegate(url, { ...init, headers });
          }
        } catch {
          // Non-JSON body — pass through untouched.
        }
      }
    }
    return delegate(url, init);
  };
}

function toAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === 'string' && reason.length > 0 ? reason : 'Aborted');
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
