import type { ToolCallResponse } from '../middleware/types.js';
import { childLogger } from '../util/logger.js';

const log = childLogger('hitl-deferred');

/** Mirrors engine.ts (kept local to avoid a runtime import cycle). */
type ApprovalKind = 'call' | 'plan' | 'question';
type HitlResult = 'approved' | 'denied' | 'timeout' | 'cancelled';

/**
 * Where an approval is in its life. `approved` is terminal only when nothing runs on approval (a
 * question, a plan, a call whose agent will retry it); a call Airlock runs itself goes
 * `executing` → `completed` | `failed` instead.
 */
export type DeferredStatus = 'pending' | 'executing' | 'completed' | 'failed' | HitlResult;
export type TerminalStatus = Exclude<DeferredStatus, 'pending' | 'executing'>;

/** Runs a held call through the agent's full pipeline. Lives in memory only, never in SQLite. */
export type DeferredRunner = () => Promise<ToolCallResponse>;

/** What an agent may learn about one of its approvals. Never the operator's approval code. */
export interface DeferredSnapshot {
  id: string;
  agentId: string;
  tool: string;
  kind: ApprovalKind;
  status: DeferredStatus;
  /** The agent was answered "pending" and the approval outlived that call. */
  detached: boolean;
  /** Airlock ran the call itself on approval (execute-on-approve). */
  executed: boolean;
  /** Whether a runner is waiting for approval (execute-on-approve will run the call). */
  willExecute: boolean;
  answer?: string;
  response?: ToolCallResponse;
  error?: string;
  decidedAt?: string;
}

/** Emitted once per approval, when it reaches a terminal status. */
export interface ApprovalDecision {
  approvalId: string;
  agentId: string;
  tool: string;
  kind: ApprovalKind;
  status: TerminalStatus;
  executed: boolean;
  detached: boolean;
  decidedAt: string;
}

interface Entry {
  id: string;
  agentId: string;
  tool: string;
  kind: ApprovalKind;
  fingerprint?: string;
  /** The agent session that made the call, when known; retries from other sessions don't match. */
  sessionId?: string;
  status: DeferredStatus;
  detached: boolean;
  executed: boolean;
  runner?: DeferredRunner;
  answer?: string;
  response?: ToolCallResponse;
  error?: string;
  decidedAt?: string;
  /** When the entry reached a terminal status (ms); TTL counts from here. */
  settledAt?: number;
  /** An identical retry already received this execution's result. */
  retryRedeemed: boolean;
  settled: Promise<void>;
  resolveSettled: () => void;
}

export interface DeferredExecutionStoreOptions {
  /** How long a decided approval (and its result) stays retrievable. */
  ttlMs: () => number;
  /** Cap on tracked approvals; the oldest decided ones are dropped first. */
  maxEntries?: number;
  /** Cap on held runners (raw args in memory); past it, approval falls back to a retry grant. */
  maxRunners?: number;
  /** Results larger than this many characters are stored truncated. */
  maxResultChars?: number;
}

const DEFAULTS = { maxEntries: 2_000, maxRunners: 500, maxResultChars: 1_000_000 };

function isTerminal(status: DeferredStatus): status is TerminalStatus {
  return status !== 'pending' && status !== 'executing';
}

/**
 * In-memory life of each approval after the gate: the runner that executes a "pending" call the
 * moment it is approved, the result that run produced (TTL-bounded, size-capped), and question
 * answers. Kept apart from the transport so MCP Tasks (or anything else) can sit on top later.
 */
export class DeferredExecutionStore {
  private entries = new Map<string, Entry>();
  private runnerCount = 0;
  private listeners = new Set<(decision: ApprovalDecision) => void>();
  private readonly maxEntries: number;
  private readonly maxRunners: number;
  private readonly maxResultChars: number;

  constructor(private opts: DeferredExecutionStoreOptions) {
    this.maxEntries = opts.maxEntries ?? DEFAULTS.maxEntries;
    this.maxRunners = opts.maxRunners ?? DEFAULTS.maxRunners;
    this.maxResultChars = opts.maxResultChars ?? DEFAULTS.maxResultChars;
  }

  /** Start tracking a newly created (or recovered) approval. */
  open(params: {
    id: string;
    agentId: string;
    tool: string;
    kind: ApprovalKind;
    fingerprint?: string;
    sessionId?: string;
    detached?: boolean;
  }): void {
    this.prune();
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => (resolveSettled = resolve));
    this.entries.set(params.id, {
      id: params.id,
      agentId: params.agentId,
      tool: params.tool,
      kind: params.kind,
      ...(params.fingerprint ? { fingerprint: params.fingerprint } : {}),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      status: 'pending',
      detached: params.detached ?? false,
      executed: false,
      retryRedeemed: false,
      settled,
      resolveSettled,
    });
  }

  /**
   * The agent was answered "pending". With a runner, approval runs the call right away; without
   * one (or past the runner cap) approval falls back to the retry grant. Returns whether the
   * runner was kept.
   */
  detach(id: string, runner?: DeferredRunner): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.status !== 'pending') return false;
    entry.detached = true;
    if (!runner || entry.runner) return Boolean(entry.runner);
    if (this.runnerCount >= this.maxRunners) {
      log.warn(
        { id, cap: this.maxRunners },
        'Deferred runner cap reached; approval will mint a retry grant'
      );
      return false;
    }
    entry.runner = runner;
    this.runnerCount += 1;
    return true;
  }

  hasRunner(id: string): boolean {
    return this.entries.get(id)?.runner !== undefined;
  }

  /** Approval landed: run the held call if there is one, otherwise record the approval. */
  approve(id: string, answer?: string): 'executing' | 'approved' | undefined {
    const entry = this.entries.get(id);
    if (!entry || entry.status !== 'pending') return undefined;
    if (answer !== undefined) entry.answer = answer;
    entry.decidedAt = new Date().toISOString();
    const runner = this.takeRunner(entry);
    if (!runner) {
      this.finish(entry, 'approved');
      return 'approved';
    }
    entry.status = 'executing';
    entry.executed = true;
    log.info({ id, tool: entry.tool }, 'Executing approved call');
    let response: Promise<ToolCallResponse>;
    try {
      response = runner();
    } catch (err) {
      response = Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    response.then(
      (value) => {
        const stored = this.capResponse(value);
        const result = stored.result as { isError?: unknown } | undefined;
        if (result?.isError === true) {
          this.finish(entry, 'failed', { response: stored, error: stored.text });
        } else {
          this.finish(entry, 'completed', { response: stored });
        }
      },
      (err: unknown) => {
        const error = err instanceof Error ? err.message : String(err);
        log.warn({ id, tool: entry.tool, error }, 'Approved call failed');
        this.finish(entry, 'failed', { error });
      }
    );
    return 'executing';
  }

  /** Denied, timed out or cancelled: drop the runner (and its raw args) and record the outcome. */
  settle(id: string, status: Exclude<HitlResult, 'approved'>): void {
    const entry = this.entries.get(id);
    if (!entry || entry.status !== 'pending') return;
    this.takeRunner(entry);
    entry.decidedAt = new Date().toISOString();
    this.finish(entry, status);
  }

  get(id: string): DeferredSnapshot | undefined {
    const entry = this.live(id);
    return entry ? snapshot(entry) : undefined;
  }

  /** Resolves once the approval is terminal (decided and, if it runs, finished running). */
  settled(id: string): Promise<void> | undefined {
    return this.live(id)?.settled;
  }

  /**
   * An identical retry of a call Airlock already ran (or is running) on approval. Hands the retry
   * that one execution instead of running a destructive call twice. Like the single-use retry grant
   * it replaces, one retry redeems it; later identical calls ask again.
   */
  claimRetry(
    agentId: string,
    fingerprint: string,
    sessionId?: string
  ): DeferredSnapshot | undefined {
    let match: Entry | undefined;
    for (const entry of this.entries.values()) {
      if (
        entry.agentId === agentId &&
        entry.fingerprint === fingerprint &&
        (entry.sessionId === undefined || entry.sessionId === sessionId) &&
        entry.executed &&
        !entry.retryRedeemed &&
        this.live(entry.id)
      ) {
        match = entry;
      }
    }
    if (!match) return undefined;
    match.retryRedeemed = true;
    return snapshot(match);
  }

  onDecision(listener: (decision: ApprovalDecision) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Tracked approvals, for tests and health. */
  size(): number {
    return this.entries.size;
  }

  private takeRunner(entry: Entry): DeferredRunner | undefined {
    const runner = entry.runner;
    if (runner) {
      entry.runner = undefined;
      this.runnerCount -= 1;
    }
    return runner;
  }

  private finish(
    entry: Entry,
    status: TerminalStatus,
    outcome: { response?: ToolCallResponse; error?: string } = {}
  ): void {
    entry.status = status;
    if (outcome.response) entry.response = outcome.response;
    if (outcome.error !== undefined) entry.error = outcome.error;
    entry.settledAt = Date.now();
    entry.decidedAt ??= new Date().toISOString();
    entry.resolveSettled();
    const decision: ApprovalDecision = {
      approvalId: entry.id,
      agentId: entry.agentId,
      tool: entry.tool,
      kind: entry.kind,
      status,
      executed: entry.executed,
      detached: entry.detached,
      decidedAt: entry.decidedAt,
    };
    for (const listener of this.listeners) {
      try {
        listener(decision);
      } catch (err) {
        log.warn({ err }, 'Approval decision listener failed');
      }
    }
  }

  private capResponse(response: ToolCallResponse): ToolCallResponse {
    if (response.text.length <= this.maxResultChars) return response;
    const text =
      response.text.slice(0, this.maxResultChars) +
      `\n[Airlock: result truncated to ${this.maxResultChars} characters]`;
    const isError = (response.result as { isError?: unknown } | undefined)?.isError === true;
    return {
      result: { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) },
      text,
      truncated: true,
    };
  }

  /** The entry, unless it is decided and past its TTL. */
  private live(id: string): Entry | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (entry.settledAt !== undefined && entry.settledAt + this.opts.ttlMs() <= Date.now()) {
      this.entries.delete(id);
      return undefined;
    }
    return entry;
  }

  private prune(): void {
    const cutoff = Date.now() - this.opts.ttlMs();
    for (const [id, entry] of this.entries) {
      if (entry.settledAt !== undefined && entry.settledAt <= cutoff) this.entries.delete(id);
    }
    if (this.entries.size < this.maxEntries) return;
    // Oldest decided entries go first; pending ones are bounded by the engine's own timeout.
    for (const [id, entry] of this.entries) {
      if (this.entries.size < this.maxEntries) break;
      if (isTerminal(entry.status)) this.entries.delete(id);
    }
  }
}

function snapshot(entry: Entry): DeferredSnapshot {
  return {
    id: entry.id,
    agentId: entry.agentId,
    tool: entry.tool,
    kind: entry.kind,
    status: entry.status,
    detached: entry.detached,
    executed: entry.executed,
    willExecute: entry.runner !== undefined,
    ...(entry.answer !== undefined ? { answer: entry.answer } : {}),
    ...(entry.response ? { response: entry.response } : {}),
    ...(entry.error !== undefined ? { error: entry.error } : {}),
    ...(entry.decidedAt ? { decidedAt: entry.decidedAt } : {}),
  };
}
