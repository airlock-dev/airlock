import { describe, it, expect, vi, afterEach } from 'vitest';
import { SlackHitlProvider } from '../src/hitl/providers/slack.js';
import { WebhookHitlProvider } from '../src/hitl/providers/webhook.js';
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

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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

    const provider = new SlackHitlProvider({ webhook_url: 'https://hooks.slack.com/services/TEST' });
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
    expect(opts.headers?.['Content-Type'] ?? opts.headers?.['content-type']).toBe('application/json');
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

    const provider = new WebhookHitlProvider({ url: 'https://ops.example.com/approvals', headers: {} });
    await provider.notify([makeNotification()]);

    const [url, opts] = fetch.mock.calls[0];
    expect(url).toBe('https://ops.example.com/approvals');
    expect(opts.method).toBe('POST');
  });

  it('notify() sends structured JSON with requests array', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetch);

    const provider = new WebhookHitlProvider({ url: 'https://example.com/hitl', headers: {} });
    await provider.notify([makeNotification({ code: 'ABC123', agentId: 'helena', tool: 'github/create_pr' })]);

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
