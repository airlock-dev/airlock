import { describe, it, expect } from 'vitest';
import { Gateway } from '../src/gateway.js';
import { GatewayConfig } from '../src/config/schema.js';

type SessionIds = {
  downstreamSessionIds: Map<string, string>;
  downstreamSessionIdFor(key: string): string;
};

describe('Gateway downstream session ids', () => {
  it('keeps ids stable per key, refreshes recency on use, and stays bounded', () => {
    const gateway = new Gateway(
      GatewayConfig.parse({ agents: { a: {} } })
    ) as unknown as SessionIds;

    const first = gateway.downstreamSessionIdFor('a:first');
    expect(gateway.downstreamSessionIdFor('a:first')).toBe(first);

    for (let i = 0; i < 10_000; i++) {
      gateway.downstreamSessionIdFor(`a:filler-${i}`);
      // Keep 'a:first' in use so the LRU never picks it.
      if (i % 1000 === 0) gateway.downstreamSessionIdFor('a:first');
    }

    expect(gateway.downstreamSessionIds.size).toBe(10_000);
    expect(gateway.downstreamSessionIdFor('a:first')).toBe(first);
    expect(gateway.downstreamSessionIds.has('a:filler-0')).toBe(false);
  });
});
