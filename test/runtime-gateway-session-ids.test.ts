import { describe, it, expect } from 'vitest';
import { Gateway } from '../src/gateway.js';
import { GatewayConfig } from '../src/config/schema.js';

type SessionIds = {
  downstreamSessionIds: Map<string, Map<string, string>>;
  downstreamSessionIdFor(agentId: string, key: string): string;
};

describe('Gateway downstream session ids', () => {
  it('keeps ids stable per key, refreshes recency on use, and stays bounded', () => {
    const gateway = new Gateway(
      GatewayConfig.parse({ agents: { a: {} } })
    ) as unknown as SessionIds;

    const first = gateway.downstreamSessionIdFor('a', 'a:first');
    expect(gateway.downstreamSessionIdFor('a', 'a:first')).toBe(first);

    for (let i = 0; i < 10_000; i++) {
      gateway.downstreamSessionIdFor('a', `a:filler-${i}`);
      // Keep 'a:first' in use so the LRU never picks it.
      if (i % 1000 === 0) gateway.downstreamSessionIdFor('a', 'a:first');
    }

    const ids = gateway.downstreamSessionIds.get('a');
    expect(ids?.size).toBe(10_000);
    expect(gateway.downstreamSessionIdFor('a', 'a:first')).toBe(first);
    expect(ids?.has('a:filler-0')).toBe(false);
  });

  it("never evicts one agent's sessions because of another agent's churn", () => {
    const gateway = new Gateway(
      GatewayConfig.parse({ agents: { a: {}, b: {} } })
    ) as unknown as SessionIds;

    const kept = gateway.downstreamSessionIdFor('a', 'a:long-lived');
    for (let i = 0; i < 10_001; i++) gateway.downstreamSessionIdFor('b', `b:churn-${i}`);

    expect(gateway.downstreamSessionIds.get('b')?.size).toBe(10_000);
    expect(gateway.downstreamSessionIdFor('a', 'a:long-lived')).toBe(kept);
  });
});
