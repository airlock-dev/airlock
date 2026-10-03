import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalPreviewConfig, ApprovalsConfig } from '../src/config/schema.js';
import { ApprovalPreviewReader } from '../src/hitl/preview.js';
import { ApprovalDashboardRoutes } from '../src/hitl/approval-dashboard.js';
import { ApprovalStreamHub } from '../src/hitl/approval-stream.js';
import type { HitlNotification } from '../src/hitl/providers/types.js';
import type { ToolRegistry } from '../src/registry/registry.js';
import type { AuditLogger } from '../src/audit/logger.js';
import Fastify from 'fastify';

function fixture() {
  let pending = true;
  const request: HitlNotification = {
    id: 'approval-1',
    code: 'ABCD1234',
    agentId: 'researcher',
    tool: 'records/update',
    args: { record_id: 'opaque-17', ignored: 'agent supplied' },
    timeoutMs: 300000,
  };
  const hooks = {
    'records/update': ApprovalPreviewConfig.parse({
      tool: 'records/read',
      args: { format: 'text' },
      args_from: { id: 'record_id' },
      timeout_ms: 100,
      max_chars: 100,
    }),
  };
  const registry = {
    call: vi
      .fn()
      .mockResolvedValue({ content: [{ type: 'text', text: '<script>private record</script>' }] }),
    getAllTools: vi
      .fn()
      .mockReturnValue([{ name: 'records/read', annotations: { readOnlyHint: true } }]),
    resolveToolName: vi.fn((tool: string) => tool),
  };
  const auditLogger = { log: vi.fn(), redactArgs: vi.fn((args) => args) };
  const reader = new ApprovalPreviewReader({
    getHooks: () => hooks,
    getRegistry: () => registry as unknown as ToolRegistry,
    isPending: () => pending,
    getRequest: (id) => (id === request.id ? request : undefined),
    auditLogger: auditLogger as unknown as AuditLogger,
  });
  return {
    reader,
    request,
    registry,
    auditLogger,
    hooks,
    resolve: () => {
      pending = false;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('approval preview configuration', () => {
  it('is opt-in and rejects patterns, unknown fields and unbounded limits', () => {
    expect(ApprovalsConfig.parse({}).previews).toEqual({});
    for (const value of [
      { previews: { 'records/*': { tool: 'records/read' } } },
      { previews: { 'records/update': { tool: 'records/*' } } },
      { previews: { 'records/update': { tool: 'records/read', command: 'cat' } } },
      { previews: { 'records/update': { tool: 'records/read', timeout_ms: 0 } } },
      { previews: { 'records/update': { tool: 'records/read', max_chars: 50001 } } },
      { previews: { 'records/update': { tool: 'records/read', fields: [{ label: 'Body' }] } } },
      {
        previews: {
          'records/update': {
            tool: 'records/read',
            fields: [{ label: 'Body', path: '/text', text_prefix: 'Body:' }],
          },
        },
      },
      {
        previews: {
          'records/update': {
            tool: 'records/read',
            fields: [{ label: 'Body', path: '/invalid~2escape' }],
          },
        },
      },
    ])
      expect(ApprovalsConfig.safeParse(value).success).toBe(false);
  });
});

describe('ApprovalPreviewReader', () => {
  it('selects fields from wrapped JSON and keeps requested arguments separate', async () => {
    const f = fixture();
    f.hooks['records/update'] = ApprovalPreviewConfig.parse({
      tool: 'records/read',
      max_chars: 500,
      fields: [
        { label: 'To', path: '/participants/*/name' },
        { label: 'Latest message', path: '/last/text', primary: true },
      ],
      request_fields: [{ label: 'Message to send', path: '/ignored', primary: true }],
    });
    f.registry.call.mockResolvedValue({
      structuredContent: {
        result: JSON.stringify({
          participants: [{ name: 'Maya' }, { name: 'Jordan' }],
          last: { text: '<b>Fetched message</b>' },
        }),
      },
    });
    expect(await f.reader.read(f.request)).toMatchObject({
      status: 'ready',
      fields: [
        { label: 'To', value: 'Maya, Jordan', primary: false },
        { label: 'Latest message', value: '<b>Fetched message</b>', primary: true },
      ],
      requestedFields: [{ label: 'Message to send', value: 'agent supplied', primary: true }],
    });
    expect(JSON.stringify(f.auditLogger.log.mock.calls)).not.toContain('Fetched message');
    expect(f.request).not.toHaveProperty('preview');
  });

  it('accepts integration fields and preserves the plain-text fallback', async () => {
    const f = fixture();
    f.registry.call.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            fields: [
              { label: 'Subject', value: 'Replacement' },
              { label: 'Body', value: 'Return required.', primary: true },
            ],
          }),
        },
      ],
    });
    expect(await f.reader.read(f.request)).toMatchObject({
      text: 'Subject: Replacement\n\nBody: Return required.',
      fields: [
        { label: 'Subject', value: 'Replacement', primary: false },
        { label: 'Body', value: 'Return required.', primary: true },
      ],
      truncated: false,
    });
  });

  it('selects literal text prefixes and falls back when the body is missing', async () => {
    const f = fixture();
    f.hooks['records/update'] = ApprovalPreviewConfig.parse({
      tool: 'records/read',
      max_chars: 500,
      fields: [
        { label: 'From', text_prefix: 'From:' },
        { label: 'Body', text_prefix: 'Body:', primary: true },
      ],
    });
    f.registry.call.mockResolvedValue({
      content: [{ type: 'text', text: 'From: Maya\r\nBody: Hello\r\nWorld' }],
    });
    expect(await f.reader.read(f.request)).toMatchObject({
      fields: [
        { label: 'From', value: 'Maya', primary: false },
        { label: 'Body', value: 'Hello\nWorld', primary: true },
      ],
    });
    const second = fixture();
    second.hooks['records/update'] = f.hooks['records/update'];
    second.registry.call.mockResolvedValue({
      content: [{ type: 'text', text: 'From: Maya\nUnrecognized body\nImportant content' }],
    });
    const fallback = await second.reader.read(second.request);
    expect(fallback).toMatchObject({ text: 'From: Maya\nUnrecognized body\nImportant content' });
    expect(fallback).not.toHaveProperty('fields');
  });

  it('redacts before extraction and resolves escaped keys without inherited properties', async () => {
    const f = fixture();
    f.hooks['records/update'] = ApprovalPreviewConfig.parse({
      tool: 'records/read',
      fields: [
        { label: 'Secret', path: '/secret' },
        { label: 'Absent', path: '/absent' },
        { label: 'Inherited', path: '/toString' },
        { label: 'Title', path: '/a~1b/~0key' },
      ],
    });
    f.registry.call.mockResolvedValue({ structuredContent: { secret: 'secret-value' } });
    f.auditLogger.redactArgs.mockImplementation(() => ({
      value: { structuredContent: { secret: '[REDACTED]', 'a/b': { '~key': 'Visible' } } },
    }));
    expect(await f.reader.read(f.request)).toMatchObject({
      fields: [
        { label: 'Secret', value: '[REDACTED]', primary: false },
        { label: 'Title', value: 'Visible', primary: false },
      ],
    });
  });

  it('bounds all displayed fields and their fallback text', async () => {
    const f = fixture();
    f.registry.call.mockResolvedValue({
      structuredContent: {
        fields: [
          { label: 'Body', value: 'x'.repeat(200), primary: true },
          { label: 'Hidden', value: 'tail' },
        ],
      },
    });
    const result = await f.reader.read(f.request);
    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.text.length).toBeLessThanOrEqual(100);
      expect(result.truncated).toBe(true);
      expect(result.fields).toHaveLength(1);
    }
  });

  it('maps only configured arguments, isolates the downstream session and coalesces reads', async () => {
    const f = fixture();
    const [first, second] = await Promise.all([f.reader.read(f.request), f.reader.read(f.request)]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      status: 'ready',
      text: '<script>private record</script>',
      truncated: false,
    });
    expect(f.registry.call).toHaveBeenCalledOnce();
    expect(f.registry.call).toHaveBeenCalledWith(
      'records/read',
      { id: 'opaque-17', format: 'text' },
      'researcher',
      { downstreamSessionId: expect.stringMatching(/^[0-9a-f-]{36}$/) }
    );
    expect(JSON.stringify(f.auditLogger.log.mock.calls)).not.toContain('private record');
    expect(f.request).not.toHaveProperty('preview');
  });

  it('does nothing for unmapped requests or resolved approvals', async () => {
    const f = fixture();
    expect(await f.reader.read({ ...f.request, tool: 'records/other' })).toEqual({
      status: 'unavailable',
    });
    f.resolve();
    expect(await f.reader.read(f.request)).toMatchObject({ status: 'error' });
    expect(f.registry.call).not.toHaveBeenCalled();
  });

  it('rejects missing, redacted and inherited source arguments before reading', async () => {
    for (const args of [
      {},
      { record_id: '[REDACTED]' },
      Object.create({ record_id: 'inherited' }),
    ]) {
      const f = fixture();
      expect(await f.reader.read({ ...f.request, args })).toMatchObject({ status: 'error' });
      expect(f.registry.call).not.toHaveBeenCalled();
    }
  });

  it('rejects unavailable, non-read-only and redirected preview tools', async () => {
    for (const setup of [
      (f: ReturnType<typeof fixture>) => f.registry.getAllTools.mockReturnValue([]),
      (f: ReturnType<typeof fixture>) =>
        f.registry.getAllTools.mockReturnValue([
          { name: 'records/read', annotations: { readOnlyHint: false } },
        ]),
      (f: ReturnType<typeof fixture>) =>
        f.registry.resolveToolName.mockReturnValue('records/delete'),
    ]) {
      const f = fixture();
      setup(f);
      expect(await f.reader.read(f.request)).toMatchObject({ status: 'error' });
      expect(f.registry.call).not.toHaveBeenCalled();
    }
  });

  it('discards results when the approval resolves during a read', async () => {
    const f = fixture();
    let complete!: (value: unknown) => void;
    f.registry.call.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      })
    );
    const reading = f.reader.read(f.request);
    f.resolve();
    complete({ content: [{ type: 'text', text: 'private record' }] });
    expect(await reading).toEqual({ status: 'error', message: 'Approval has resolved.' });
    expect(await f.reader.read(f.request)).toMatchObject({ status: 'error' });
  });

  it('bounds wait time and suppresses upstream error content', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.registry.call.mockReturnValue(new Promise(() => {}));
    const reading = f.reader.read(f.request);
    await vi.advanceTimersByTimeAsync(101);
    expect(await reading).toMatchObject({ status: 'error' });
    const failure = fixture();
    failure.registry.call.mockRejectedValue(new Error('secret message and credential'));
    const error = await failure.reader.read(failure.request);
    expect(JSON.stringify([error, failure.auditLogger.log.mock.calls])).not.toContain(
      'secret message'
    );
    const toolError = fixture();
    toolError.registry.call.mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: 'secret message' }],
    });
    expect(await toolError.reader.read(toolError.request)).toEqual({
      status: 'error',
      message: 'Preview read failed.',
    });
  });

  it('renders structured results, applies field redaction and truncates output', async () => {
    const f = fixture();
    f.registry.call.mockResolvedValue({
      structuredContent: { title: 'x'.repeat(200), token: 'secret' },
    });
    f.auditLogger.redactArgs.mockImplementation(() => ({
      value: { structuredContent: { title: 'x'.repeat(200), token: '[REDACTED]' } },
    }));
    const result = await f.reader.read(f.request);
    expect(result).toMatchObject({ status: 'ready', truncated: true });
    if (result.status === 'ready') expect(result.text.length).toBe(100);
  });
});

describe('approval preview routes', () => {
  it('accepts only a pending ID, ignores caller-supplied targets and keeps previews out of streams', async () => {
    const f = fixture();
    const hub = new ApprovalStreamHub();
    await hub.notify([f.request]);
    const api = { approve: vi.fn(), deny: vi.fn(), approveByCode: vi.fn(), denyByCode: vi.fn() };
    const app = Fastify();
    new ApprovalDashboardRoutes(api, hub, f.reader).registerRoutes(app);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/approval-preview/approval-1',
        payload: { tool: 'records/delete', args: { id: 'other' } },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toMatchObject({ status: 'ready' });
      expect(JSON.stringify(hub.getPendingById(f.request.id))).not.toContain('private record');
      expect(api.approve).not.toHaveBeenCalled();
      f.resolve();
      expect(
        (await app.inject({ method: 'POST', url: '/approval-preview/approval-1' })).statusCode
      ).toBe(409);
      expect(
        (await app.inject({ method: 'POST', url: '/approval-preview/ABCD1234' })).statusCode
      ).toBe(409);
      expect(f.registry.call).toHaveBeenCalledOnce();
    } finally {
      await app.close();
      await hub.stop();
    }
  });
});
