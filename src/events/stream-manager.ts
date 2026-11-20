import { childLogger } from '../util/logger.js';
import { EVENTS_ERROR_CODES, createEventsError, type EventStreamErrorObject } from './protocol.js';

const log = childLogger('events:streams');

export interface EventStreamLimits {
  maxEventStreamsPerAgent: number;
  maxEventStreamsGlobal: number;
}

export interface TrackedEventStream {
  id: string;
  agentId: string;
  eventName: string;
  args: Record<string, unknown>;
  /**
   * Send `notifications/events/terminated` to the downstream client (if possible) and tear down
   * both upstream and downstream sides of the stream.
   */
  terminate: (error: EventStreamErrorObject) => Promise<void>;
  /** Graceful close on gateway shutdown (sends final frame without a Forbidden error). */
  closeGracefully: () => Promise<void>;
}

/**
 * Tracks live downstream `events/stream` subscriptions across the gateway.
 *
 * Enforces dedicated per-agent and global stream caps (separate from general request caps, per
 * SEP-3415), supports live revocation when config reloads revoke an agent's permission or tighten
 * `events.arg_policy`, and cleanly shuts down open SSE streams before Fastify closes.
 */
export class EventStreamManager {
  private readonly streams = new Map<string, TrackedEventStream>();
  private readonly perAgentCount = new Map<string, number>();

  constructor(private readonly getLimits: (agentId: string) => EventStreamLimits) {}

  /**
   * Reserve a slot for a new `events/stream`. Throws SEP-3415 `ResourceExhausted` (`-32025`) when
   * per-agent or global subscription ceilings are reached.
   */
  tryAdmit(agentId: string): void {
    const limits = this.getLimits(agentId);
    const agentCount = this.perAgentCount.get(agentId) ?? 0;
    if (agentCount >= limits.maxEventStreamsPerAgent) {
      throw createEventsError(
        EVENTS_ERROR_CODES.ResourceExhausted,
        `Concurrent event stream limit reached for agent (${limits.maxEventStreamsPerAgent})`,
        { limit: 'subscriptions', max: limits.maxEventStreamsPerAgent }
      );
    }

    if (this.streams.size >= limits.maxEventStreamsGlobal) {
      throw createEventsError(
        EVENTS_ERROR_CODES.ResourceExhausted,
        `Gateway event stream limit reached (${limits.maxEventStreamsGlobal})`,
        { limit: 'subscriptions', max: limits.maxEventStreamsGlobal }
      );
    }
  }

  register(stream: TrackedEventStream): void {
    if (this.streams.has(stream.id)) return;
    this.streams.set(stream.id, stream);
    this.perAgentCount.set(stream.agentId, (this.perAgentCount.get(stream.agentId) ?? 0) + 1);
  }

  unregister(streamId: string): void {
    const existing = this.streams.get(streamId);
    if (!existing) return;
    this.streams.delete(streamId);
    const remaining = (this.perAgentCount.get(existing.agentId) ?? 1) - 1;
    if (remaining <= 0) this.perAgentCount.delete(existing.agentId);
    else this.perAgentCount.set(existing.agentId, remaining);
  }

  /**
   * Re-check every open stream after a config reload or event catalog refresh.
   * Any stream that is no longer permitted receives `notifications/events/terminated` with the
   * returned error (`Forbidden` `-32024` or `NotFound` `-32023`) and is torn down immediately.
   */
  async revokeDisallowed(
    check: (
      stream: Pick<TrackedEventStream, 'agentId' | 'eventName' | 'args'>
    ) => EventStreamErrorObject | undefined
  ): Promise<number> {
    const toTerminate: Array<{ stream: TrackedEventStream; error: EventStreamErrorObject }> = [];
    for (const stream of this.streams.values()) {
      const error = check(stream);
      if (error) toTerminate.push({ stream, error });
    }

    if (toTerminate.length === 0) return 0;

    log.info(
      { count: toTerminate.length },
      'Terminating event streams after policy/catalog reload'
    );
    await Promise.allSettled(
      toTerminate.map(async ({ stream, error }) => {
        this.unregister(stream.id);
        await stream.terminate(error);
      })
    );
    return toTerminate.length;
  }

  /** Gracefully close every active stream during gateway/stdio shutdown. */
  async closeAll(): Promise<void> {
    const active = Array.from(this.streams.values());
    this.streams.clear();
    this.perAgentCount.clear();
    await Promise.allSettled(active.map((stream) => stream.closeGracefully()));
  }

  snapshot(): { total: number; perAgent: Record<string, number> } {
    const perAgent: Record<string, number> = {};
    for (const [agentId, count] of this.perAgentCount) {
      perAgent[agentId] = count;
    }
    return { total: this.streams.size, perAgent };
  }
}
