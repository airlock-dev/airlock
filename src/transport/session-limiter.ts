import type { LimitsConfig } from '../config/schema.js';
import { childLogger } from '../util/logger.js';

const log = childLogger('session-limiter');

/**
 * Per-agent transport-layer safeties (bulkheads). One agent must never be able to exhaust the
 * gateway — via a session-init storm, a leaked/never-closed session pile-up, or a connection
 * flood — and thereby starve every other agent's tool calls.
 *
 * A single SessionLimiter instance is shared across all transport planes (streamable-HTTP and
 * SSE) so caps and ceilings are enforced globally, not per-plane.
 *
 * HITL-awareness is central: an agent's async task may legitimately hold a session open for
 * minutes-to-hours while a human approves it. Such a session is NOT idle — its request stays
 * in flight the whole time — so the idle reaper skips any session with inFlight > 0, and the
 * default max-lifetime cap is disabled.
 */

export interface ResolvedLimits {
  maxSessionsPerAgent: number;
  maxSessionsGlobal: number;
  sessionIdleMs: number;
  sessionMaxLifetimeMs: number;
  newSessionMax: number;
  newSessionWindowMs: number;
  maxConcurrentCallsPerAgent: number;
  callExecutionTimeoutMs: number;
}

// Generous defaults: high enough that a healthy fleet never notices them, low enough that the
// observed failure mode (~200 session inits / 10s from one token, none ever closing) is stopped
// with wide margin. All *_ms values: 0 = disabled.
export const DEFAULT_LIMITS: ResolvedLimits = {
  maxSessionsPerAgent: 16,
  maxSessionsGlobal: 256,
  sessionIdleMs: 600_000, // 10 min with no in-flight request
  sessionMaxLifetimeMs: 0, // disabled — never sever a long-running approved async task
  newSessionMax: 30,
  newSessionWindowMs: 10_000, // 30 new sessions / 10s per agent
  maxConcurrentCallsPerAgent: 8,
  callExecutionTimeoutMs: 0, // disabled by default — async downstream calls can be long
};

/** Merge per-agent limits over global limits over built-in defaults, field by field. */
export function resolveLimits(agent?: LimitsConfig, global?: LimitsConfig): ResolvedLimits {
  return {
    maxSessionsPerAgent:
      agent?.max_sessions_per_agent ??
      global?.max_sessions_per_agent ??
      DEFAULT_LIMITS.maxSessionsPerAgent,
    maxSessionsGlobal:
      agent?.max_sessions_global ??
      global?.max_sessions_global ??
      DEFAULT_LIMITS.maxSessionsGlobal,
    sessionIdleMs:
      agent?.session_idle_ms ?? global?.session_idle_ms ?? DEFAULT_LIMITS.sessionIdleMs,
    sessionMaxLifetimeMs:
      agent?.session_max_lifetime_ms ??
      global?.session_max_lifetime_ms ??
      DEFAULT_LIMITS.sessionMaxLifetimeMs,
    newSessionMax:
      agent?.new_session_max ?? global?.new_session_max ?? DEFAULT_LIMITS.newSessionMax,
    newSessionWindowMs:
      agent?.new_session_window_ms ??
      global?.new_session_window_ms ??
      DEFAULT_LIMITS.newSessionWindowMs,
    maxConcurrentCallsPerAgent:
      agent?.max_concurrent_calls_per_agent ??
      global?.max_concurrent_calls_per_agent ??
      DEFAULT_LIMITS.maxConcurrentCallsPerAgent,
    callExecutionTimeoutMs:
      agent?.call_execution_timeout_ms ??
      global?.call_execution_timeout_ms ??
      DEFAULT_LIMITS.callExecutionTimeoutMs,
  };
}

export type AdmitResult = { ok: true } | { ok: false; status: number; message: string };

interface Tracked {
  profileId: string;
  openedAt: number;
  lastSeen: number;
  inFlight: number;
  abort: () => void;
}

export interface SessionLimiterOptions {
  /** Resolve the effective limits for a given agent (per-agent over global over defaults). */
  getLimits: (profileId: string) => ResolvedLimits;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Sweep cadence for the idle/lifetime reaper. */
  sweepIntervalMs?: number;
}

export class SessionLimiter {
  private readonly sessions = new Map<string, Tracked>();
  private readonly perAgentCount = new Map<string, number>();
  private readonly recentOpens = new Map<string, number[]>();
  private readonly getLimits: (profileId: string) => ResolvedLimits;
  private readonly now: () => number;
  private readonly sweepIntervalMs: number;
  private timer?: ReturnType<typeof setInterval>;

  constructor(opts: SessionLimiterOptions) {
    this.getLimits = opts.getLimits;
    this.now = opts.now ?? Date.now;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 30_000;
  }

  /** Start the background reaper. Safe to call once. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), this.sweepIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Decide whether a NEW session may be opened for this agent. Enforced BEFORE the initialize
   * handshake so a rejected client never allocates a transport or an upstream server. Checks,
   * in order: per-agent new-session rate, per-agent concurrent-session cap, global ceiling.
   */
  tryOpen(profileId: string): AdmitResult {
    const limits = this.getLimits(profileId);
    const now = this.now();

    // Per-agent new-session rate limit (sliding window).
    const opens = this.pruneOpens(profileId, limits.newSessionWindowMs, now);
    if (opens.length >= limits.newSessionMax) {
      const retryMs = Math.max(0, opens[0] + limits.newSessionWindowMs - now);
      log.warn(
        { profileId, limit: limits.newSessionMax, windowMs: limits.newSessionWindowMs },
        'Rejected new session: per-agent init rate limit exceeded'
      );
      return {
        ok: false,
        status: 429,
        message: `Session init rate limit exceeded for agent (${limits.newSessionMax}/${limits.newSessionWindowMs}ms). Retry after ${retryMs}ms.`,
      };
    }

    // Per-agent concurrent-session cap.
    const count = this.perAgentCount.get(profileId) ?? 0;
    if (count >= limits.maxSessionsPerAgent) {
      log.warn(
        { profileId, count, limit: limits.maxSessionsPerAgent },
        'Rejected new session: per-agent concurrent-session cap reached'
      );
      return {
        ok: false,
        status: 429,
        message: `Concurrent session cap reached for agent (${limits.maxSessionsPerAgent}). Close an existing session and retry.`,
      };
    }

    // Global ceiling (backstop for the whole box).
    if (this.sessions.size >= limits.maxSessionsGlobal) {
      log.error(
        { profileId, total: this.sessions.size, limit: limits.maxSessionsGlobal },
        'Rejected new session: global session ceiling reached'
      );
      return {
        ok: false,
        status: 429,
        message: `Gateway session ceiling reached (${limits.maxSessionsGlobal}). Retry shortly.`,
      };
    }

    // Admitted — record the open timestamp against the rate window.
    opens.push(now);
    this.recentOpens.set(profileId, opens);
    return { ok: true };
  }

  /** Register a session once its id is known (initialize handshake completed). */
  register(sessionId: string, profileId: string, abort: () => void): void {
    if (this.sessions.has(sessionId)) return;
    const now = this.now();
    this.sessions.set(sessionId, { profileId, openedAt: now, lastSeen: now, inFlight: 0, abort });
    this.perAgentCount.set(profileId, (this.perAgentCount.get(profileId) ?? 0) + 1);
  }

  /** Mark activity (bumps idle clock). */
  touch(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) s.lastSeen = this.now();
  }

  /** A request began on this session — it is now busy and exempt from idle reaping. */
  beginRequest(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.inFlight += 1;
      s.lastSeen = this.now();
    }
  }

  /** A request finished (response streamed or aborted). */
  endRequest(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.inFlight = Math.max(0, s.inFlight - 1);
      s.lastSeen = this.now();
    }
  }

  /** Remove a closed session from accounting. */
  close(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    const remaining = (this.perAgentCount.get(s.profileId) ?? 1) - 1;
    if (remaining <= 0) this.perAgentCount.delete(s.profileId);
    else this.perAgentCount.set(s.profileId, remaining);
  }

  /**
   * Reap sessions that are idle (no in-flight request for longer than sessionIdleMs) or that
   * exceed their max lifetime. A session awaiting HITL approval keeps its request in flight, so
   * it is never reaped here. Aborting the session triggers its transport onclose → close().
   */
  sweep(): void {
    const now = this.now();
    for (const [id, s] of this.sessions) {
      const limits = this.getLimits(s.profileId);
      const idleReap =
        limits.sessionIdleMs > 0 && s.inFlight === 0 && now - s.lastSeen > limits.sessionIdleMs;
      const lifetimeReap =
        limits.sessionMaxLifetimeMs > 0 && now - s.openedAt > limits.sessionMaxLifetimeMs;
      if (idleReap || lifetimeReap) {
        log.info(
          { profileId: s.profileId, sessionId: id, reason: idleReap ? 'idle' : 'lifetime' },
          'Reaping session'
        );
        // close() runs via the transport onclose handler that abort() fires; guard just in case.
        try {
          s.abort();
        } catch (err) {
          log.warn({ sessionId: id, err }, 'Error aborting reaped session');
        }
        this.close(id);
      }
    }
  }

  /** Per-agent open-session counts, for the health/metrics gauge. */
  snapshot(): { total: number; perAgent: Record<string, number> } {
    const perAgent: Record<string, number> = {};
    for (const [profileId, count] of this.perAgentCount) perAgent[profileId] = count;
    return { total: this.sessions.size, perAgent };
  }

  private pruneOpens(profileId: string, windowMs: number, now: number): number[] {
    const cutoff = now - windowMs;
    const arr = this.recentOpens.get(profileId) ?? [];
    const idx = arr.findIndex((t) => t > cutoff);
    return idx === -1 ? [] : arr.slice(idx);
  }
}
