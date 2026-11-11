import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AuditLogger } from '../src/audit/logger.js';
import { HitlEngine } from '../src/hitl/engine.js';
import { HitlBatcher } from '../src/hitl/batcher.js';
import { wireBatcher } from '../src/hitl/runtime.js';
import { ApprovalStreamHub } from '../src/hitl/approval-stream.js';
import { ApprovalDashboardRoutes } from '../src/hitl/approval-dashboard.js';
import { mobileApiPlugin } from '../src/mobile/api.js';

const ADMIN = { authorization: 'Bearer admin-secret' };

describe('approval decision routes', () => {
  let dir: string;
  let configPath: string;
  let auditLogger: AuditLogger;
  let hub: ApprovalStreamHub;
  let engine: HitlEngine;
  let batcher: HitlBatcher;
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'airlock-runtime-routes-'));
    configPath = join(dir, 'airlock.yaml');
    writeFileSync(configPath, 'agents:\n  dev:\n    ask: [exec/run]\n');
    auditLogger = new AuditLogger({
      db_path: join(dir, 'audit.db'),
      retention_days: 30,
      redact_fields: [],
    });
    hub = new ApprovalStreamHub();
    engine = new HitlEngine(auditLogger, hub, 300_000);
    batcher = new HitlBatcher(0);
    wireBatcher(batcher, engine, hub);
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    auditLogger.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Create a gated call and wait until it has been notified, as an operator would see it. */
  async function notifiedCall(): Promise<{ id: string; code: string }> {
    const ticket = engine.create({
      agentId: 'dev',
      tool: 'exec/run',
      args: { command: 'pwd' },
      kind: 'call',
      mode: 'sync',
    });
    const notification = engine.buildNotification(ticket.id);
    if (notification) batcher.add(notification);
    await vi.waitFor(() => expect(hub.getPendingByCode(ticket.code)).toBeDefined());
    return ticket;
  }

  describe('dashboard /approve and /deny', () => {
    beforeEach(async () => {
      const dashboard = Fastify({ logger: false });
      new ApprovalDashboardRoutes(engine, hub).registerRoutes(dashboard, configPath);
      await dashboard.ready();
      app = dashboard;
    });

    it('refuses a missing code and an unknown code instead of reporting success', async () => {
      for (const action of ['approve', 'deny']) {
        const missing = await app!.inject({ method: 'POST', url: `/${action}` });
        expect(missing.statusCode).toBe(400);
        const unknown = await app!.inject({ method: 'POST', url: `/${action}?code=NOPE1234` });
        expect(unknown.statusCode).toBe(404);
        expect(unknown.json()).toEqual({ error: 'No pending approval found for code' });
      }
    });

    it('refuses a code that was already resolved elsewhere', async () => {
      const ticket = await notifiedCall();
      engine.approve(ticket.id);
      const response = await app!.inject({ method: 'POST', url: `/deny?code=${ticket.code}` });
      expect(response.statusCode).toBe(404);
    });

    it('approves and denies pending codes', async () => {
      const approved = await notifiedCall();
      const denied = await notifiedCall();
      const ok = await app!.inject({ method: 'POST', url: `/approve?code=${approved.code}` });
      expect(ok.statusCode).toBe(200);
      const no = await app!.inject({ method: 'POST', url: `/deny?code=${denied.code}` });
      expect(no.statusCode).toBe(200);
      expect(auditLogger.getHitlById(approved.id)?.status).toBe('approved');
      expect(auditLogger.getHitlById(denied.id)?.status).toBe('denied');
    });

    it('accepts a batch code', async () => {
      const first = engine.create({ agentId: 'dev', tool: 'exec/run', args: { n: 1 } });
      const second = engine.create({ agentId: 'dev', tool: 'exec/run', args: { n: 2 } });
      for (const ticket of [first, second]) batcher.add(engine.buildNotification(ticket.id)!);
      await vi.waitFor(() => expect(hub.getPendingByCode(first.code)?.batchCode).toBeDefined());
      const batchCode = hub.getPendingByCode(first.code)!.batchCode!;

      const response = await app!.inject({ method: 'POST', url: `/approve?code=${batchCode}` });
      expect(response.statusCode).toBe(200);
      expect(engine.pendingCount()).toBe(0);
    });

    it('ignores duration_ms on an "always" rule rather than failing after approving', async () => {
      const ticket = await notifiedCall();
      const response = await app!.inject({
        method: 'POST',
        url: `/approve?code=${ticket.code}&remember=always&duration_ms=abc`,
      });
      expect(response.statusCode).toBe(200);
      expect(auditLogger.getHitlById(ticket.id)?.status).toBe('approved');
      expect(readFileSync(configPath, 'utf8')).toContain('remember_allow');
    });
  });

  describe('mobile decision', () => {
    async function mobileApp(withConfigPath: boolean): Promise<FastifyInstance> {
      const mobile = Fastify({ logger: false });
      await mobile.register(mobileApiPlugin, {
        auditLogger,
        engine,
        secret: 'admin-secret',
        authRequired: true,
        ...(withConfigPath ? { configPath } : {}),
      });
      await mobile.ready();
      return mobile;
    }

    it('refuses "always" without a config to write, before approving', async () => {
      app = await mobileApp(false);
      const ticket = await notifiedCall();
      const response = await app!.inject({
        method: 'POST',
        url: `/mobile/approvals/${ticket.id}/decision`,
        headers: ADMIN,
        payload: { decision: 'approved', remember: 'always' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'Config mutation is not available' });
      expect(engine.hasPending(ticket.id)).toBe(true);
    });

    it('uses a neutral default deny reason', async () => {
      app = await mobileApp(true);
      const ticket = await notifiedCall();
      const response = await app!.inject({
        method: 'POST',
        url: `/mobile/approvals/${ticket.id}/decision`,
        headers: ADMIN,
        payload: { decision: 'denied' },
      });
      expect(response.statusCode).toBe(200);
      expect(auditLogger.getHitlById(ticket.id)?.reason).toBe('Denied by operator');
    });

    it('lists pending approvals with the engine creation and expiry times', async () => {
      app = await mobileApp(true);
      const ticket = await notifiedCall();
      const response = await app!.inject({
        method: 'GET',
        url: '/mobile/approvals',
        headers: ADMIN,
      });
      const [approval] = response.json().approvals as Array<Record<string, string>>;
      expect(approval.id).toBe(ticket.id);
      expect(approval.createdAt).toBe(auditLogger.getHitlById(ticket.id)?.created_at);
      expect(Date.parse(approval.expiresAt) - Date.parse(approval.createdAt)).toBeGreaterThan(
        299_000
      );
    });
  });

  it('stream "new" events carry createdAt and expiresAt', async () => {
    const ticket = await notifiedCall();
    const request = hub.getPendingByCode(ticket.code)!;
    expect(request.createdAt).toBe(auditLogger.getHitlById(ticket.id)?.created_at);
    expect(typeof request.expiresAt).toBe('string');
    expect(Date.parse(request.expiresAt!)).toBeGreaterThan(Date.parse(request.createdAt!));
  });
});
