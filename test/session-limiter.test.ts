import { describe, it, expect } from 'vitest';
import {
  SessionLimiter,
  resolveLimits,
  DEFAULT_LIMITS,
  type ResolvedLimits,
} from '../src/transport/session-limiter.js';

function limiter(overrides: Partial<ResolvedLimits> = {}, now: () => number = () => 0) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const clock = { t: now() };
  const l = new SessionLimiter({ getLimits: () => limits, now: () => clock.t });
  return { l, clock };
}

describe('resolveLimits', () => {
  it('prefers per-agent over global over defaults, field by field', () => {
    const r = resolveLimits({ max_sessions_per_agent: 3 }, { max_sessions_global: 50 });
    expect(r.maxSessionsPerAgent).toBe(3); // agent
    expect(r.maxSessionsGlobal).toBe(50); // global
    expect(r.sessionIdleMs).toBe(DEFAULT_LIMITS.sessionIdleMs); // default
  });

  it('falls back entirely to defaults when nothing is set', () => {
    expect(resolveLimits()).toEqual(DEFAULT_LIMITS);
  });
});

describe('SessionLimiter caps', () => {
  it('enforces the per-agent concurrent-session cap', () => {
    const { l } = limiter({ maxSessionsPerAgent: 2 });
    expect(l.tryOpen('a').ok).toBe(true);
    l.register('s1', 'a', () => {});
    expect(l.tryOpen('a').ok).toBe(true);
    l.register('s2', 'a', () => {});

    const denied = l.tryOpen('a');
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.status).toBe(429);

    // A different agent is unaffected — bulkheads are per-agent.
    expect(l.tryOpen('b').ok).toBe(true);
  });

  it('frees a slot when a session closes', () => {
    const { l } = limiter({ maxSessionsPerAgent: 1 });
    l.tryOpen('a');
    l.register('s1', 'a', () => {});
    expect(l.tryOpen('a').ok).toBe(false);
    l.close('s1');
    expect(l.tryOpen('a').ok).toBe(true);
  });

  it('enforces the global ceiling across agents', () => {
    const { l } = limiter({ maxSessionsGlobal: 2, maxSessionsPerAgent: 100 });
    l.tryOpen('a');
    l.register('s1', 'a', () => {});
    l.tryOpen('b');
    l.register('s2', 'b', () => {});
    const denied = l.tryOpen('c');
    expect(denied.ok).toBe(false);
  });
});

describe('SessionLimiter new-session rate limit', () => {
  it('rejects an init storm and recovers after the window', () => {
    const { l, clock } = limiter({ newSessionMax: 3, newSessionWindowMs: 1000, maxSessionsPerAgent: 100 });
    expect(l.tryOpen('a').ok).toBe(true);
    expect(l.tryOpen('a').ok).toBe(true);
    expect(l.tryOpen('a').ok).toBe(true);
    expect(l.tryOpen('a').ok).toBe(false); // 4th within window → denied

    clock.t = 1001; // window elapsed
    expect(l.tryOpen('a').ok).toBe(true);
  });

  it('rate limit is per-agent', () => {
    const { l } = limiter({ newSessionMax: 1, newSessionWindowMs: 1000, maxSessionsPerAgent: 100 });
    expect(l.tryOpen('a').ok).toBe(true);
    expect(l.tryOpen('a').ok).toBe(false);
    expect(l.tryOpen('b').ok).toBe(true); // different agent, own bucket
  });
});

describe('SessionLimiter idle reaper (HITL-aware)', () => {
  it('reaps an idle session after sessionIdleMs', () => {
    const { l, clock } = limiter({ sessionIdleMs: 100 });
    let aborted = false;
    l.tryOpen('a');
    l.register('s1', 'a', () => {
      aborted = true;
      l.close('s1'); // mimic transport onclose → limiter.close
    });

    clock.t = 50;
    l.sweep();
    expect(aborted).toBe(false); // not yet idle long enough

    clock.t = 201;
    l.sweep();
    expect(aborted).toBe(true);
    expect(l.snapshot().total).toBe(0);
  });

  it('NEVER reaps a session with an in-flight request (parked on approval)', () => {
    const { l, clock } = limiter({ sessionIdleMs: 100 });
    let aborted = false;
    l.tryOpen('a');
    l.register('s1', 'a', () => {
      aborted = true;
    });
    l.beginRequest('s1'); // a long HITL-gated call holds the request open

    clock.t = 10_000; // far beyond idle threshold
    l.sweep();
    expect(aborted).toBe(false); // in-flight → exempt

    // Once the call completes, it becomes eligible again.
    l.endRequest('s1');
    clock.t = 20_000;
    l.sweep();
    expect(aborted).toBe(true);
  });

  it('does not reap on idle when sessionIdleMs is 0 (disabled)', () => {
    const { l, clock } = limiter({ sessionIdleMs: 0 });
    let aborted = false;
    l.tryOpen('a');
    l.register('s1', 'a', () => {
      aborted = true;
    });
    clock.t = 1_000_000;
    l.sweep();
    expect(aborted).toBe(false);
  });

  it('enforces a max lifetime when configured, even if busy', () => {
    const { l, clock } = limiter({ sessionIdleMs: 0, sessionMaxLifetimeMs: 500 });
    let aborted = false;
    l.tryOpen('a');
    l.register('s1', 'a', () => {
      aborted = true;
    });
    l.beginRequest('s1');
    clock.t = 501;
    l.sweep();
    expect(aborted).toBe(true); // lifetime cap ignores in-flight
  });
});

describe('SessionLimiter snapshot', () => {
  it('reports per-agent open counts', () => {
    const { l } = limiter({ maxSessionsPerAgent: 100 });
    l.tryOpen('a');
    l.register('s1', 'a', () => {});
    l.tryOpen('a');
    l.register('s2', 'a', () => {});
    l.tryOpen('b');
    l.register('s3', 'b', () => {});
    expect(l.snapshot()).toEqual({ total: 3, perAgent: { a: 2, b: 1 } });
  });
});
