import { describe, it, expect } from 'vitest';
import { formatNotification, formatBatch } from '../src/hitl/formatter.js';
import type { HitlNotification } from '../src/hitl/providers/types.js';

function makeReq(overrides: Partial<HitlNotification> = {}): HitlNotification {
  return {
    id: 'req-1',
    code: 'ABC123',
    agentId: 'helena',
    tool: 'github/create_pr',
    args: { repo: 'amoura-inc/amoura', title: 'Fix auth' },
    timeoutMs: 300000,
    ...overrides,
  };
}

describe('formatNotification()', () => {
  it('includes the approval code in the header', () => {
    const out = formatNotification(makeReq({ code: 'XY9Z01' }));
    expect(out).toContain('[XY9Z01]');
  });

  it('includes agent and tool', () => {
    const out = formatNotification(makeReq());
    expect(out).toContain('Agent: helena');
    expect(out).toContain('Tool:  github/create_pr');
  });

  it('includes approve and deny command lines with the code', () => {
    const out = formatNotification(makeReq({ code: 'ABC123' }));
    expect(out).toContain('approve ABC123');
    expect(out).toContain('deny ABC123');
  });

  it('shows timeout in minutes', () => {
    const out = formatNotification(makeReq({ timeoutMs: 300000 })); // 5 min
    expect(out).toContain('Expires: 5m');
  });

  it('rounds timeout to nearest minute', () => {
    const out = formatNotification(makeReq({ timeoutMs: 90000 })); // 1.5 min → 2
    expect(out).toContain('Expires: 2m');
  });

  it('renders string args with quotes', () => {
    const out = formatNotification(makeReq({ args: { title: 'My PR' } }));
    expect(out).toContain('"My PR"');
  });

  it('truncates string args longer than 200 chars', () => {
    const longStr = 'x'.repeat(250);
    const out = formatNotification(makeReq({ args: { body: longStr } }));
    expect(out).toContain('(truncated)');
    expect(out).not.toContain('x'.repeat(250));
  });

  it('renders non-string args as JSON', () => {
    const out = formatNotification(makeReq({ args: { count: 42, flag: true } }));
    expect(out).toContain('42');
    expect(out).toContain('true');
  });

  it('handles empty args', () => {
    expect(() => formatNotification(makeReq({ args: {} }))).not.toThrow();
  });
});

describe('formatBatch()', () => {
  it('single request: same output as formatNotification', () => {
    const req = makeReq();
    expect(formatBatch([req])).toBe(formatNotification(req));
  });

  it('multiple requests: includes count header', () => {
    const out = formatBatch([makeReq({ code: 'AAA111' }), makeReq({ code: 'BBB222' })]);
    expect(out).toContain('2 APPROVAL REQUESTS');
  });

  it('multiple requests: includes all codes', () => {
    const out = formatBatch([makeReq({ code: 'AAA111' }), makeReq({ code: 'BBB222' })]);
    expect(out).toContain('AAA111');
    expect(out).toContain('BBB222');
  });

  it('multiple requests: includes separator between items', () => {
    const out = formatBatch([makeReq(), makeReq()]);
    expect(out).toContain('---');
  });
});
