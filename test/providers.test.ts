import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter, Readable } from 'stream';
import { StdioHitlProvider } from '../src/hitl/providers/stdio.js';
import { TelegramHitlProvider } from '../src/hitl/providers/telegram.js';
import { parseApprovalCommand } from '../src/hitl/parser.js';
import type { ApprovalApi, HitlNotification } from '../src/hitl/providers/types.js';

// ─── parseApprovalCommand (shared parser) ────────────────────────────────────

describe('parseApprovalCommand()', () => {
  it('parses approve command', () => {
    const result = parseApprovalCommand('approve ABC123');
    expect(result).toEqual({ type: 'approve', code: 'ABC123' });
  });

  it('parses deny command', () => {
    const result = parseApprovalCommand('deny ABC123');
    expect(result).toEqual({ type: 'deny', code: 'ABC123' });
  });

  it('parses deny with reason', () => {
    const result = parseApprovalCommand('deny ABC123 too risky');
    expect(result).toEqual({ type: 'deny', code: 'ABC123', reason: 'too risky' });
  });

  it('is case-insensitive', () => {
    expect(parseApprovalCommand('APPROVE abc123')).toMatchObject({
      type: 'approve',
      code: 'ABC123',
    });
    expect(parseApprovalCommand('Deny ABC123')).toMatchObject({ type: 'deny', code: 'ABC123' });
  });

  it('returns null for non-matching input', () => {
    expect(parseApprovalCommand('hello world')).toBeNull();
    expect(parseApprovalCommand('approve')).toBeNull(); // no code
    expect(parseApprovalCommand('approve SHORT')).toBeNull(); // too short (5 chars)
    expect(parseApprovalCommand('approve TOOLONGCODE1')).toBeNull(); // too long (11 chars)
    expect(parseApprovalCommand('')).toBeNull();
  });

  it('parses openclaw-style prefixed commands', () => {
    expect(parseApprovalCommand('hitl approve ABC123')).toEqual({
      type: 'approve',
      code: 'ABC123',
    });
    expect(parseApprovalCommand('hitl deny ABC123 reason here')).toEqual({
      type: 'deny',
      code: 'ABC123',
      reason: 'reason here',
    });
  });
});

// ─── StdioHitlProvider ────────────────────────────────────────────────────────

function makeApprovalApi() {
  return { approve: vi.fn(), deny: vi.fn(), approveByCode: vi.fn(), denyByCode: vi.fn() };
}

function makeNotification(overrides: Partial<HitlNotification> = {}): HitlNotification {
  return {
    id: '1',
    code: 'ABC123',
    agentId: 'agent1',
    tool: 'github/create_pr',
    args: {},
    timeoutMs: 300000,
    ...overrides,
  };
}

describe('StdioHitlProvider', () => {
  it('calls approve when "approve <CODE>" line received', async () => {
    const api = makeApprovalApi();
    const stream = new Readable({ read() {} });
    const provider = new StdioHitlProvider(api, stream);
    await provider.init();
    stream.push('approve ABC123\n');
    await new Promise((r) => setTimeout(r, 10));
    expect(api.approveByCode).toHaveBeenCalledWith('ABC123');
  });

  it('calls deny when "deny <CODE>" line received', async () => {
    const api = makeApprovalApi();
    const stream = new Readable({ read() {} });
    const provider = new StdioHitlProvider(api, stream);
    await provider.init();
    stream.push('deny ABC123\n');
    await new Promise((r) => setTimeout(r, 10));
    expect(api.denyByCode).toHaveBeenCalledWith('ABC123', undefined);
  });

  it('calls deny with reason', async () => {
    const api = makeApprovalApi();
    const stream = new Readable({ read() {} });
    const provider = new StdioHitlProvider(api, stream);
    await provider.init();
    stream.push('deny ABC123 not today\n');
    await new Promise((r) => setTimeout(r, 10));
    expect(api.denyByCode).toHaveBeenCalledWith('ABC123', 'not today');
  });

  it('ignores non-approval input', async () => {
    const api = makeApprovalApi();
    const stream = new Readable({ read() {} });
    const provider = new StdioHitlProvider(api, stream);
    await provider.init();
    stream.push('hello world\n');
    stream.push('random text\n');
    await new Promise((r) => setTimeout(r, 10));
    expect(api.approveByCode).not.toHaveBeenCalled();
    expect(api.denyByCode).not.toHaveBeenCalled();
  });

  it('is case-insensitive for commands', async () => {
    const api = makeApprovalApi();
    const stream = new Readable({ read() {} });
    const provider = new StdioHitlProvider(api, stream);
    await provider.init();
    stream.push('APPROVE ABC123\n');
    await new Promise((r) => setTimeout(r, 10));
    expect(api.approveByCode).toHaveBeenCalledWith('ABC123');
  });

  it('writes formatted notification to stderr on notify()', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const provider = new StdioHitlProvider(makeApprovalApi());
    await provider.notify([makeNotification({ code: 'XYZ999' })]);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('XYZ999'));
    stderrSpy.mockRestore();
  });

  it('stop() closes readline without throwing', async () => {
    const stream = new Readable({ read() {} });
    const provider = new StdioHitlProvider(makeApprovalApi(), stream);
    await provider.init();
    await expect(provider.stop()).resolves.not.toThrow();
  });
});

// ─── TelegramHitlProvider ─────────────────────────────────────────────────────

function makeTelegramProvider(api: ApprovalApi = makeApprovalApi()) {
  return new TelegramHitlProvider({ bot_token: 'test-token', chat_id: '12345' }, api);
}

function makeFetchWithUpdates(
  updates: Array<{ update_id: number; message?: { text: string; chat?: { id: number } } }>
) {
  return vi.fn().mockImplementation((url: string) => {
    if (url.includes('getUpdates')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true, result: updates }),
      });
    }
    // sendMessage
    return Promise.resolve({ ok: true, status: 200 });
  });
}

describe('TelegramHitlProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('sends notification via sendMessage API', async () => {
    const fetch = makeFetchWithUpdates([]);
    vi.stubGlobal('fetch', fetch);
    const provider = makeTelegramProvider();
    await provider.init();
    await provider.notify([makeNotification({ code: 'TG1234' })]);
    const sendCall = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(([url]: [string]) =>
      url.includes('sendMessage')
    );
    expect(sendCall).toBeDefined();
    const body = JSON.parse(sendCall[1].body);
    expect(body.chat_id).toBe('12345');
    expect(body.text).toContain('TG1234');
    await provider.stop();
  });

  it('calls approve when polling returns approve message', async () => {
    vi.useRealTimers();
    const api = makeApprovalApi();
    const fetch = makeFetchWithUpdates([
      { update_id: 1, message: { text: 'approve AB1234', chat: { id: 99 } } },
    ]);
    vi.stubGlobal('fetch', fetch);
    const provider = new TelegramHitlProvider({ bot_token: 'tok', chat_id: '99' }, api);
    await provider.init();
    // Let poll run
    await new Promise((r) => setTimeout(r, 1100));
    await provider.stop();
    expect(api.approveByCode).toHaveBeenCalledWith('AB1234');
    vi.useFakeTimers();
  });

  it('calls deny when polling returns deny message', async () => {
    vi.useRealTimers();
    const api = makeApprovalApi();
    const fetch = makeFetchWithUpdates([
      { update_id: 2, message: { text: 'deny AB1234 nope', chat: { id: 99 } } },
    ]);
    vi.stubGlobal('fetch', fetch);
    const provider = new TelegramHitlProvider({ bot_token: 'tok', chat_id: '99' }, api);
    await provider.init();
    await new Promise((r) => setTimeout(r, 1100));
    await provider.stop();
    expect(api.denyByCode).toHaveBeenCalledWith('AB1234', 'nope');
    vi.useFakeTimers();
  });

  it('ignores messages from unauthorized chats', async () => {
    vi.useRealTimers();
    const api = makeApprovalApi();
    const fetch = makeFetchWithUpdates([
      { update_id: 1, message: { text: 'approve AB1234', chat: { id: 777 } } },
    ]);
    vi.stubGlobal('fetch', fetch);
    const provider = new TelegramHitlProvider({ bot_token: 'tok', chat_id: '99' }, api);
    await provider.init();
    await new Promise((r) => setTimeout(r, 1100));
    await provider.stop();
    expect(api.approveByCode).not.toHaveBeenCalled();
    vi.useFakeTimers();
  });

  it('advances lastUpdateId to prevent re-processing', async () => {
    vi.useRealTimers();
    const api = makeApprovalApi();
    let callCount = 0;
    const fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('getUpdates')) {
        callCount++;
        // First call returns update, second returns empty (since offset advanced)
        const result =
          callCount === 1
            ? [{ update_id: 5, message: { text: 'approve AB1234', chat: { id: 99 } } }]
            : [];
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ok: true, result }),
        });
      }
      return Promise.resolve({ ok: true, status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    const provider = new TelegramHitlProvider({ bot_token: 'tok', chat_id: '99' }, api);
    await provider.init();
    await new Promise((r) => setTimeout(r, 2200)); // two poll cycles
    await provider.stop();
    // approve should only be called once
    expect(api.approveByCode).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
  });

  it('stop() prevents further polling', async () => {
    vi.useRealTimers();
    const fetch = makeFetchWithUpdates([]);
    vi.stubGlobal('fetch', fetch);
    const provider = makeTelegramProvider();
    await provider.init();
    await provider.stop();
    const callsBefore = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    await new Promise((r) => setTimeout(r, 1500));
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
    vi.useFakeTimers();
  });
});
