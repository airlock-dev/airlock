import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { EventEmitter } from 'events';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { connect, constants } from 'http2';
import { tmpdir } from 'os';
import { join } from 'path';
import { ApnsClient } from '../src/mobile/apns.js';

vi.mock('http2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('http2')>()),
  connect: vi.fn(),
}));

describe('APNs approval notifications', () => {
  let dir: string;
  let client: ApnsClient;
  let request: ReturnType<typeof vi.fn>;
  let end: ReturnType<typeof vi.fn>;
  let close: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'airlock-apns-'));
    const keyPath = join(dir, 'key.p8');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    client = new ApnsClient({
      keyPath,
      teamId: 'TEAM',
      keyId: 'KEY',
      bundleId: 'bot.airlock.companion',
      production: false,
    });
    const stream = new EventEmitter();
    end = vi.fn(() => {
      stream.emit('response', { [constants.HTTP2_HEADER_STATUS]: 200 });
      stream.emit('end');
    });
    request = vi.fn(() => Object.assign(stream, { setEncoding: vi.fn(), end }));
    close = vi.fn();
    vi.mocked(connect).mockReturnValue({ request, close } as unknown as ReturnType<typeof connect>);
  });

  afterEach(() => {
    vi.clearAllMocks();
    rmSync(dir, { recursive: true });
  });

  it.each(['approved', 'denied', 'cancelled', 'timeout'] as const)(
    'sends %s as a silent background update with the approval identity',
    async (result) => {
      await expect(
        client.sendApprovalStatus('device-token', {
          id: 'approval-id',
          code: 'ABCD1234',
          result,
          badgeCount: 2,
        })
      ).resolves.toEqual({ ok: true, status: 200 });
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          ':path': '/3/device/device-token',
          'apns-topic': 'bot.airlock.companion',
          'apns-push-type': 'background',
          'apns-priority': '5',
        })
      );
      expect(JSON.parse(end.mock.calls[0][0])).toEqual({
        aps: { 'content-available': 1 },
        event: 'approval_resolved',
        approval_id: 'approval-id',
        code: 'ABCD1234',
        result,
      });
      expect(close).toHaveBeenCalledOnce();
    }
  );

  it('keeps approval alerts identifiable and badged', async () => {
    await client.sendApproval('device-token', {
      id: 'approval-id',
      code: 'ABCD1234',
      agentId: 'dev',
      tool: 'exec/run',
      body: 'Read the working tree',
      timeoutMs: 300000,
      badgeCount: 2,
    });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ 'apns-push-type': 'alert', 'apns-priority': '10' })
    );
    expect(JSON.parse(end.mock.calls[0][0])).toMatchObject({
      aps: { category: 'AIRLOCK_APPROVAL', badge: 2 },
      approval_id: 'approval-id',
      code: 'ABCD1234',
    });
  });
});
