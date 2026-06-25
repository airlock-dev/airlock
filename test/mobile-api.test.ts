import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AuditLogger } from '../src/audit/logger.js';
import { mobileApiPlugin } from '../src/mobile/api.js';
import { HitlEngine } from '../src/hitl/engine.js';
import { ActivityStream } from '../src/activity/stream.js';
import type { AuditConfig } from '../src/config/schema.js';

function makeProvider() {
  return {
    init: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

describe('mobileApiPlugin', () => {
  let dir: string;
  let app: FastifyInstance;
  let auditLogger: AuditLogger;
  let engine: HitlEngine;
  let activityStream: ActivityStream;
  let approvalStream: { addClient: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'airlock-mobile-test-'));
    const config: AuditConfig = {
      db_path: join(dir, 'audit.db'),
      retention_days: 90,
      redact_fields: ['token', 'secret'],
    };
    auditLogger = new AuditLogger(config);
    engine = new HitlEngine(auditLogger, makeProvider(), 300000);
    activityStream = new ActivityStream();
    approvalStream = {
      addClient: vi.fn((_request: FastifyRequest, reply: FastifyReply) => {
        reply.send({ stream: true });
      }),
    };
    app = Fastify({ logger: false });
    await app.register(mobileApiPlugin, {
      auditLogger,
      engine,
      activityStream,
      secret: 'admin-secret',
      authRequired: true,
      approvalStream,
    });
  });

  afterEach(async () => {
    await app.close();
    auditLogger.stop();
    rmSync(dir, { recursive: true });
  });

  it('registers an iOS device and accepts approval decisions from its token', async () => {
    const register = await app.inject({
      method: 'POST',
      url: '/mobile/devices/register',
      headers: { authorization: 'Bearer admin-secret' },
      payload: {
        name: 'Charles iPhone',
        platform: 'ios',
        pushToken: 'apns-token',
      },
    });
    expect(register.statusCode).toBe(200);
    const registered = register.json<{ id: string; token: string }>();
    expect(registered.token).toMatch(/^airlock_mobile_/);

    const ticket = engine.create({
      agentId: 'codex',
      tool: 'exec/run',
      args: { cmd: 'git status' },
      context: {
        reason: 'Need to verify the working tree before pushing.',
        note: 'Read-only command.',
      },
    });

    const pending = await app.inject({
      method: 'GET',
      url: '/mobile/approvals',
      headers: { authorization: `Bearer ${registered.token}` },
    });
    expect(pending.statusCode).toBe(200);
    const pendingBody = pending.json<{
      approvals: Array<{ timeoutMs?: number; expiresAt?: string; reason?: string; note?: string }>;
    }>();
    expect(pendingBody.approvals).toHaveLength(1);
    expect(pendingBody.approvals[0].timeoutMs).toBe(300000);
    expect(pendingBody.approvals[0].expiresAt).toEqual(expect.any(String));
    expect(pendingBody.approvals[0].reason).toBe('Need to verify the working tree before pushing.');
    expect(pendingBody.approvals[0].note).toBe('Read-only command.');

    const decision = await app.inject({
      method: 'POST',
      url: `/mobile/approvals/${ticket.id}/decision`,
      headers: { authorization: `Bearer ${registered.token}` },
      payload: { decision: 'approved' },
    });
    expect(decision.statusCode).toBe(200);
    await expect(ticket.result).resolves.toBe('approved');
  });

  it('rejects unauthenticated mobile requests', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/mobile/approvals',
    });
    expect(response.statusCode).toBe(401);
  });

  it('lets a mobile token revoke its own device', async () => {
    const register = await app.inject({
      method: 'POST',
      url: '/mobile/devices/register',
      headers: { authorization: 'Bearer admin-secret' },
      payload: {
        name: 'Charles iPhone',
        platform: 'ios',
        pushToken: 'apns-token',
      },
    });
    const registered = register.json<{ token: string }>();

    const revoke = await app.inject({
      method: 'DELETE',
      url: '/mobile/device',
      headers: { authorization: `Bearer ${registered.token}` },
    });
    expect(revoke.statusCode).toBe(200);

    const pending = await app.inject({
      method: 'GET',
      url: '/mobile/approvals',
      headers: { authorization: `Bearer ${registered.token}` },
    });
    expect(pending.statusCode).toBe(401);
  });

  it('returns recent Airlock activity to mobile clients', async () => {
    activityStream.emit({
      kind: 'notification',
      agentId: 'codex',
      title: 'Heads up',
      body: 'The agent needs your attention.',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/mobile/activity',
      headers: { authorization: 'Bearer admin-secret' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      events: [
        {
          kind: 'notification',
          agentId: 'codex',
          title: 'Heads up',
          body: 'The agent needs your attention.',
          severity: 'info',
        },
      ],
    });
  });

  it('authenticates the mobile approval stream with admin or device tokens', async () => {
    const unauthorized = await app.inject({
      method: 'GET',
      url: '/mobile/approvals/stream',
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(approvalStream.addClient).not.toHaveBeenCalled();

    const adminStream = await app.inject({
      method: 'GET',
      url: '/mobile/approvals/stream',
      headers: { authorization: 'Bearer admin-secret' },
    });
    expect(adminStream.statusCode).toBe(200);
    expect(adminStream.json()).toEqual({ stream: true });
    expect(approvalStream.addClient).toHaveBeenCalledOnce();
    approvalStream.addClient.mockClear();

    const register = await app.inject({
      method: 'POST',
      url: '/mobile/devices/register',
      headers: { authorization: 'Bearer admin-secret' },
      payload: {
        name: 'Charles iPhone',
        platform: 'ios',
        pushToken: 'apns-token',
      },
    });
    const registered = register.json<{ token: string }>();

    const deviceStream = await app.inject({
      method: 'GET',
      url: '/mobile/approvals/stream',
      headers: { authorization: `Bearer ${registered.token}` },
    });
    expect(deviceStream.statusCode).toBe(200);
    expect(deviceStream.json()).toEqual({ stream: true });
    expect(approvalStream.addClient).toHaveBeenCalledOnce();
  });
});
