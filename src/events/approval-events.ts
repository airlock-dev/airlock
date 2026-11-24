import type { ApprovalDecision } from '../hitl/deferred.js';
import { sanitizeToolName } from '../util/tool-name.js';
import {
  EVENTS_ERROR_CODES,
  createEventsError,
  type EventDescriptor,
  type EventOccurrence,
} from './protocol.js';

/** Built-in gateway event: one of the agent's "pending" approvals reached a final state. */
export const APPROVAL_DECIDED_EVENT = 'airlock/approval_decided';

export const APPROVAL_DECIDED_DESCRIPTOR: EventDescriptor = {
  name: APPROVAL_DECIDED_EVENT,
  description:
    'One of your Airlock approvals that was answered "pending" reached a final state (completed, failed, approved, denied, timeout or cancelled). Call airlock_await_approval with the approvalId for the result.',
  delivery: ['poll', 'push'],
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  payloadSchema: {
    type: 'object',
    properties: {
      approvalId: { type: 'string' },
      tool: { type: 'string' },
      kind: { type: 'string', enum: ['call', 'plan', 'question'] },
      status: {
        type: 'string',
        enum: ['approved', 'completed', 'failed', 'denied', 'timeout', 'cancelled'],
      },
      executed: { type: 'boolean' },
      decidedAt: { type: 'string' },
    },
    required: ['approvalId', 'tool', 'kind', 'status', 'executed', 'decidedAt'],
  },
};

const CURSOR_PREFIX = 'apd_';
const DEFAULT_CAPACITY_PER_AGENT = 200;

interface AgentFeed {
  seq: number;
  events: Array<{ seq: number; at: number; occurrence: EventOccurrence }>;
}

export interface ApprovalPollResult {
  events: EventOccurrence[];
  cursor: string;
  truncated?: boolean;
  hasMore?: boolean;
}

/**
 * Recent approval decisions, per agent: a bounded ring buffer each agent polls with its own cursor,
 * plus live listeners for push streams. Strictly per agent: an agent never sees another agent's
 * decisions, and never an approval code (decisions don't carry one).
 */
export class ApprovalDecisionFeed {
  private feeds = new Map<string, AgentFeed>();
  private listeners = new Set<(agentId: string, occurrence: EventOccurrence) => void>();

  constructor(private readonly capacityPerAgent = DEFAULT_CAPACITY_PER_AGENT) {}

  /** Only approvals the agent was answered "pending" for: an inline decision needs no wake-up. */
  record(decision: ApprovalDecision): void {
    if (!decision.detached) return;
    let feed = this.feeds.get(decision.agentId);
    if (!feed) {
      feed = { seq: 0, events: [] };
      this.feeds.set(decision.agentId, feed);
    }
    feed.seq += 1;
    const cursor = `${CURSOR_PREFIX}${feed.seq}`;
    const occurrence: EventOccurrence = {
      eventId: `${decision.approvalId}:${decision.status}`,
      name: APPROVAL_DECIDED_EVENT,
      timestamp: decision.decidedAt,
      data: {
        approvalId: decision.approvalId,
        tool: sanitizeToolName(decision.tool),
        kind: decision.kind,
        status: decision.status,
        executed: decision.executed,
        decidedAt: decision.decidedAt,
      },
      cursor,
    };
    feed.events.push({ seq: feed.seq, at: Date.now(), occurrence });
    if (feed.events.length > this.capacityPerAgent) feed.events.shift();
    for (const listener of this.listeners) listener(decision.agentId, occurrence);
  }

  /** The cursor that points just past everything the agent has so far. */
  latestCursor(agentId: string): string {
    return `${CURSOR_PREFIX}${this.feeds.get(agentId)?.seq ?? 0}`;
  }

  /**
   * Events after `cursor`. Without a cursor, everything still buffered (within `maxAgeMs`), so a
   * decision that landed between the "pending" answer and the first poll is not missed.
   */
  poll(
    agentId: string,
    cursor: string | null | undefined,
    opts: { maxEvents?: number; maxAgeMs?: number } = {}
  ): ApprovalPollResult {
    const feed = this.feeds.get(agentId);
    const after = cursor ? parseCursor(cursor) : 0;
    const events = feed?.events ?? [];
    const cutoff = opts.maxAgeMs !== undefined ? Date.now() - opts.maxAgeMs : undefined;
    const fresh = events.filter(
      (entry) => entry.seq > after && (cutoff === undefined || entry.at >= cutoff)
    );
    const limited = opts.maxEvents !== undefined ? fresh.slice(0, opts.maxEvents) : fresh;
    const last = limited.at(-1)?.seq ?? Math.max(after, feed?.seq ?? 0);
    // Events between the cursor and the oldest still buffered were dropped.
    const oldest = events[0]?.seq;
    const truncated =
      cursor !== undefined && cursor !== null && oldest !== undefined && oldest > after + 1;
    return {
      events: limited.map((entry) => entry.occurrence),
      cursor: `${CURSOR_PREFIX}${last}`,
      ...(truncated ? { truncated: true } : {}),
      ...(limited.length < fresh.length ? { hasMore: true } : {}),
    };
  }

  subscribe(listener: (agentId: string, occurrence: EventOccurrence) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function parseCursor(cursor: string): number {
  const seq = cursor.startsWith(CURSOR_PREFIX) ? Number(cursor.slice(CURSOR_PREFIX.length)) : NaN;
  if (!Number.isInteger(seq) || seq < 0) {
    throw createEventsError(EVENTS_ERROR_CODES.InvalidParams, 'Invalid approval event cursor');
  }
  return seq;
}
