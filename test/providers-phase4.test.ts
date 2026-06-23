import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SlackHitlProvider } from '../src/hitl/providers/slack.js';
import { WebhookHitlProvider } from '../src/hitl/providers/webhook.js';
import { IOSHitlProvider } from '../src/hitl/providers/ios.js';
import { ApnsClient } from '../src/mobile/apns.js';
import type { HitlNotification } from '../src/hitl/providers/types.js';

function makeNotification(overrides: Partial<HitlNotification> = {}): HitlNotification {
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── IOSHitlProvider ──────────────────────────────────────────────────────────

describe('IOSHitlProvider', () => {
  it('sends structured approval context for the notification content extension', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'airlock-apns-test-'));
    const keyPath = join(dir, 'AuthKey_TEST.p8');
    writeFileSync(keyPath, 'test-key');

    const sendApproval = vi
      .spyOn(ApnsClient.prototype, 'sendApproval')
      .mockResolvedValue({ ok: true, status: 200 });
    const auditLogger = {
      getActiveMobileDevices: vi
        .fn()
        .mockReturnValue([{ id: 'device-1', push_token: 'apns-token' }]),
    } as unknown as import('../src/audit/logger.js').AuditLogger;

    const provider = new IOSHitlProvider(
      {
        teamId: 'TEAMID',
        keyId: 'KEYID',
        keyPath,
        bundleId: 'bot.airlock.companion',
        production: false,
      },
      auditLogger
    );

    await provider.notify([
      makeNotification({
        id: 'approval-1',
        code: 'XY9Z01',
        agentId: 'dev',
        tool: 'echo/add',
        args: {
          a: 1,
          b: 2,
          purpose: 'expanded notification',
          nested: { ok: true },
          extra1: 'one',
          extra2: 'two',
          extra3: 'three',
          extra4: 'four',
          extra5: 'five',
        },
        context: {
          reason: 'Need to push the reviewed auth fix.',
          note: 'Tests passed locally.',
        },
        timeoutMs: 120000,
      }),
    ]);

    expect(sendApproval).toHaveBeenCalledOnce();
    expect(sendApproval.mock.calls[0][1]).toMatchObject({
      id: 'approval-1',
      code: 'XY9Z01',
      agentId: 'dev',
      tool: 'echo/add',
      body: expect.stringContaining('Reason: Need to push the reviewed auth fix.'),
      context: {
        id: 'approval-1',
        code: 'XY9Z01',
        agentId: 'dev',
        tool: 'echo/add',
        reason: 'Need to push the reviewed auth fix.',
        note: 'Tests passed locally.',
        timeoutMs: 120000,
      },
    });
    expect(sendApproval.mock.calls[0][1].body).not.toContain('XY9Z01');
    expect(sendApproval.mock.calls[0][1].context?.args).toHaveLength(8);
    expect(sendApproval.mock.calls[0][1].context?.args).toContainEqual({
      key: 'nested',
      value: '{"ok":true}',
    });
    expect(sendApproval.mock.calls[0][1].context?.expiresAt).toEqual(expect.any(String));
  });

  it('sends APNs alerts for notification activity but ignores log activity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'airlock-apns-test-'));
    const keyPath = join(dir, 'AuthKey_TEST.p8');
    writeFileSync(keyPath, 'test-key');

    const sendActivity = vi
      .spyOn(ApnsClient.prototype, 'sendActivity')
      .mockResolvedValue({ ok: true, status: 200 });
    const auditLogger = {
      getActiveMobileDevices: vi
        .fn()
        .mockReturnValue([{ id: 'device-1', push_token: 'apns-token' }]),
    } as unknown as import('../src/audit/logger.js').AuditLogger;

    const provider = new IOSHitlProvider(
      {
        teamId: 'TEAMID',
        keyId: 'KEYID',
        keyPath,
        bundleId: 'bot.airlock.companion',
        production: false,
      },
      auditLogger
    );

    await provider.notifyActivity({
      id: 'activity-1',
      kind: 'notification',
      agentId: 'dev',
      title: 'Build finished',
      body: 'The agent is done.',
      severity: 'success',
      createdAt: '2026-06-22T12:00:00.000Z',
    });
    await provider.notifyActivity({
      id: 'activity-2',
      kind: 'log',
      agentId: 'dev',
      title: 'Quiet trace',
      body: 'No notification should be sent.',
      severity: 'info',
      createdAt: '2026-06-22T12:01:00.000Z',
    });

    expect(sendActivity).toHaveBeenCalledOnce();
    expect(sendActivity).toHaveBeenCalledWith('apns-token', {
      id: 'activity-1',
      kind: 'notification',
      agentId: 'dev',
      title: 'Build finished',
      body: 'The agent is done.',
      severity: 'success',
      createdAt: '2026-06-22T12:00:00.000Z',
    });
  });
});

// ─── SlackHitlProvider ────────────────────────────────────────────────────────

describe('SlackHitlProvider', () => {
  it('init() resolves without error', async () => {
    const provider = new SlackHitlProvider({ webhook_url: 'https://hooks.slack.com/test' });
    await expect(provider.init()).resolves.not.toThrow();
  });

  it('stop() resolves without error', async () => {
    const provider = new SlackHitlProvider({ webhook_url: 'https://hooks.slack.com/test' });
    await provider.init();
    await expect(provider.stop()).resolves.not.toThrow();
  });

  it('notify() POSTs to the webhook URL', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetch);

    const provider = new SlackHitlProvider({
      webhook_url: 'https://hooks.slack.com/services/TEST',
    });
    await provider.notify([makeNotification()]);

    expect(fetch).toHaveBeenCalledOnce();
    const [url, opts] = fetch.mock.calls[0];
    expect(url).toBe('https://hooks.slack.com/services/TEST');
    expect(opts.method).toBe('POST');
  });

  it('notify() sends Content-Type: application/json', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetch);

    const provider = new SlackHitlProvider({ webhook_url: 'https://hooks.slack.com/test' });
    await provider.notify([makeNotification()]);

    const [, opts] = fetch.mock.calls[0];
    expect(opts.headers?.['Content-Type'] ?? opts.headers?.['content-type']).toBe(
      'application/json'
    );
  });

  it('notify() body includes the approval code', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetch);

    const provider = new SlackHitlProvider({ webhook_url: 'https://hooks.slack.com/test' });
    await provider.notify([makeNotification({ code: 'XY9Z01' })]);

    const [, opts] = fetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(JSON.stringify(body)).toContain('XY9Z01');
  });

  it('notify() body includes agent and tool', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetch);

    const provider = new SlackHitlProvider({ webhook_url: 'https://hooks.slack.com/test' });
    await provider.notify([makeNotification({ agentId: 'helena', tool: 'github/create_pr' })]);

    const [, opts] = fetch.mock.calls[0];
    const bodyStr = opts.body as string;
    expect(bodyStr).toContain('helena');
    expect(bodyStr).toContain('github/create_pr');
  });

  it('notify() sends a single request for multiple notifications', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetch);

    const provider = new SlackHitlProvider({ webhook_url: 'https://hooks.slack.com/test' });
    await provider.notify([
      makeNotification({ code: 'AAA111' }),
      makeNotification({ code: 'BBB222' }),
    ]);

    expect(fetch).toHaveBeenCalledOnce();
    const [, opts] = fetch.mock.calls[0];
    expect(opts.body).toContain('AAA111');
    expect(opts.body).toContain('BBB222');
  });

  it('notify() logs warning on non-2xx response but does not throw', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 400 });
    vi.stubGlobal('fetch', fetch);

    const provider = new SlackHitlProvider({ webhook_url: 'https://hooks.slack.com/test' });
    await expect(provider.notify([makeNotification()])).resolves.not.toThrow();
  });
});

// ─── WebhookHitlProvider ──────────────────────────────────────────────────────

describe('WebhookHitlProvider', () => {
  it('init() resolves without error', async () => {
    const provider = new WebhookHitlProvider({ url: 'https://example.com/hitl', headers: {} });
    await expect(provider.init()).resolves.not.toThrow();
  });

  it('stop() resolves without error', async () => {
    const provider = new WebhookHitlProvider({ url: 'https://example.com/hitl', headers: {} });
    await expect(provider.stop()).resolves.not.toThrow();
  });

  it('notify() POSTs to configured URL', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetch);

    const provider = new WebhookHitlProvider({
      url: 'https://ops.example.com/approvals',
      headers: {},
    });
    await provider.notify([makeNotification()]);

    const [url, opts] = fetch.mock.calls[0];
    expect(url).toBe('https://ops.example.com/approvals');
    expect(opts.method).toBe('POST');
  });

  it('notify() sends structured JSON with requests array', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetch);

    const provider = new WebhookHitlProvider({ url: 'https://example.com/hitl', headers: {} });
    await provider.notify([
      makeNotification({ code: 'ABC123', agentId: 'helena', tool: 'github/create_pr' }),
    ]);

    const [, opts] = fetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body).toHaveProperty('requests');
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0]).toMatchObject({
      id: 'req-1',
      code: 'ABC123',
      agentId: 'helena',
      tool: 'github/create_pr',
    });
  });

  it('notify() sends all requests in a batch', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetch);

    const provider = new WebhookHitlProvider({ url: 'https://example.com/hitl', headers: {} });
    await provider.notify([
      makeNotification({ code: 'AAA111' }),
      makeNotification({ code: 'BBB222' }),
    ]);

    const [, opts] = fetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.requests).toHaveLength(2);
    expect(body.requests.map((r: { code: string }) => r.code)).toContain('AAA111');
    expect(body.requests.map((r: { code: string }) => r.code)).toContain('BBB222');
  });

  it('notify() includes formatted text field', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetch);

    const provider = new WebhookHitlProvider({ url: 'https://example.com/hitl', headers: {} });
    await provider.notify([makeNotification({ code: 'XYZ999' })]);

    const [, opts] = fetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body).toHaveProperty('text');
    expect(body.text).toContain('XYZ999');
  });

  it('notify() sends configured headers', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetch);

    const provider = new WebhookHitlProvider({
      url: 'https://example.com/hitl',
      headers: { 'X-Secret': 'token123', 'X-Source': 'airlock' },
    });
    await provider.notify([makeNotification()]);

    const [, opts] = fetch.mock.calls[0];
    expect(opts.headers?.['X-Secret']).toBe('token123');
    expect(opts.headers?.['X-Source']).toBe('airlock');
  });

  it('notify() always includes Content-Type: application/json', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetch);

    const provider = new WebhookHitlProvider({ url: 'https://example.com/hitl', headers: {} });
    await provider.notify([makeNotification()]);

    const [, opts] = fetch.mock.calls[0];
    expect(opts.headers?.['Content-Type']).toBe('application/json');
  });

  it('notify() logs warning on non-2xx but does not throw', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 502 });
    vi.stubGlobal('fetch', fetch);

    const provider = new WebhookHitlProvider({ url: 'https://example.com/hitl', headers: {} });
    await expect(provider.notify([makeNotification()])).resolves.not.toThrow();
  });
});
