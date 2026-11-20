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
const EVENTS_NAMED_METHODS = new Set<string>([
  EVENT_METHODS.poll,
  EVENT_METHODS.stream,
  EVENT_METHODS.subscribe,
  EVENT_METHODS.unsubscribe,
]);

export interface UpstreamEventStreamCallbacks {
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
   * Resolves once `notifications/events/active` arrives; rejects if the server returns an immediate
   * JSON-RPC error (`Forbidden`, `InvalidParams`, `NotFound`, `Unsupported`) or times out before
   * confirming.
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

    const settle = (outcome: {
      cause: 'local' | 'graceful' | 'terminated' | 'remote';
      error?: Error;
    }) => {
      if (settled) return;
      settled = true;
      clearAckTimer();
      if (onCallerAbort) {
        options.signal?.removeEventListener('abort', onCallerAbort);
      }
      const entry = this.eventStreams.get(streamId);
      this.eventStreams.delete(streamId);
      requestAbort.abort();

      const finish = () => {
        if (!acked) {
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

      // Drain any already-queued notification callbacks before signalling stream closure so
      // consumers receive the final event or `terminated` frame before `closed` resolves.
      if (entry) {
        void entry.chain.finally(finish);
      } else {
        finish();
      }
    };

    const wireTeardown = async () => {
      requestAbort.abort();
      await this.notification({
        method: 'notifications/cancelled',
        params: { requestId: streamId },
      }).catch(() => {});
    };

    const close = async () => {
      if (settled) return;
      settle({ cause: 'local' });
      await wireTeardown();
    };

    const state: StreamState = {
      callbacks,
      ackReceived: false,
      chain: Promise.resolve(),
      onActive: (active) => {
        clearAckTimer();
        const firstAck = !acked;
        acked = true;
        state.ackReceived = true;
        if (firstAck) {
          resolveActive(active);
        } else {
          // Mid-stream `notifications/events/active` signals a gap (`truncated: true`) per SEP-3415.
          state.chain = state.chain.then(() => callbacks.onActive?.(active)).catch(() => {});
        }
      },
      settle,
    };

    this.eventStreams.set(streamId, state);

    const ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_STREAM_ACK_TIMEOUT_MS;
    ackTimer = setTimeout(() => {
      settle({
        cause: 'remote',
        error: new SdkError(SdkErrorCode.RequestTimeout, 'events/stream confirmation timed out', {
          timeout: ackTimeoutMs,
        }),
      });
      void wireTeardown();
    }, ackTimeoutMs);
    ackTimer.unref?.();

    if (options.signal) {
      const callerSignal = options.signal;
      onCallerAbort = () => {
        if (settled) return;
        settle({
          cause: 'local',
          error: toAbortError(callerSignal.reason),
        });
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
        entry.chain = entry.chain.then(() => entry.callbacks.onEvent(parsed.data)).catch(() => {});
      }
      return;
    }

    if (method === EVENT_NOTIFICATIONS.heartbeat) {
      const parsed = EventStreamHeartbeatParamsSchema.safeParse(rawParams);
      if (parsed.success) {
        entry.chain = entry.chain
          .then(() => entry.callbacks.onHeartbeat?.(parsed.data))
          .catch(() => {});
      }
      return;
    }

    if (method === EVENT_NOTIFICATIONS.error) {
      const parsed = EventStreamErrorParamsSchema.safeParse(rawParams);
      if (parsed.success) {
        entry.chain = entry.chain
          .then(() => entry.callbacks.onError?.(parsed.data))
          .catch(() => {});
      }
      return;
    }

    if (method === EVENT_NOTIFICATIONS.terminated) {
      const parsed = EventStreamTerminatedParamsSchema.safeParse(rawParams);
      if (parsed.success) {
        const terminated = parsed.data;
        entry.chain = entry.chain
          .then(() => entry.callbacks.onTerminated?.(terminated))
          .catch(() => {});
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
    if (this.eventStreams.size > 0) {
      const err = new SdkError(
        SdkErrorCode.ConnectionClosed,
        'events/stream: upstream connection closed'
      );
      for (const entry of Array.from(this.eventStreams.values())) {
        entry.settle({ cause: 'remote', error: err });
      }
    }
    super._onclose();
  }
}

/**
 * Wrap a `fetch` function for `StreamableHTTPClientTransport` so outgoing SEP-3415 `events/*`
 * requests carry the required `Mcp-Name` routing header (`params.name`).
 *
 * SDK v2.3.1's `StreamableHTTPClientTransport` does not yet include `events/*` in its built-in
 * `MCP_NAME_HEADER_SOURCE` table and strips `mcp-name` from per-request `options.headers`, so
 * injecting at the fetch seam guarantees full SEP-3415 HTTP wire compliance.
 */
export function wrapFetchWithEventHeaders(
  baseFetch?: (url: string | URL, init?: RequestInit) => Promise<Response>
): (url: string | URL, init?: RequestInit) => Promise<Response> {
  return (url, init) => {
    const delegate = baseFetch ?? globalThis.fetch;
    if (init?.method?.toUpperCase() === 'POST' && typeof init.body === 'string') {
      const headers = new Headers(init.headers);
      const mcpMethod = headers.get('mcp-method');
      if (mcpMethod && EVENTS_NAMED_METHODS.has(mcpMethod) && !headers.has('mcp-name')) {
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
