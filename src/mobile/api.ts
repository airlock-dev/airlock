import { createHash, randomBytes } from 'crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuditLogger } from '../audit/logger.js';
import type { ApprovalStreamClient } from '../hitl/approval-stream.js';
import type { HitlEngine } from '../hitl/engine.js';
import type { ActivityStream, AirlockActivityEvent } from '../activity/stream.js';
import { rememberAllow, type RememberAllowMode } from '../config/mutator.js';
import { checkRequestSecurity, type RequestSecurityOptions } from '../security/request.js';
import { generateId } from '../util/id.js';

interface MobileApiOptions {
  auditLogger: AuditLogger;
  engine: HitlEngine;
  activityStream?: ActivityStream;
  configPath?: string;
  secret?: string;
  authRequired?: boolean;
  allowedOrigins?: string[];
  getRequestSecurity?: () => RequestSecurityOptions;
  approvalStream?: ApprovalStreamClient;
}

interface RegisterDeviceBody {
  name?: string;
  platform?: string;
  pushToken?: string;
}

interface UpdateDeviceBody {
  pushToken?: string;
}

interface DecisionBody {
  decision?: string;
  remember?: string;
  duration_ms?: number;
  reason?: string;
}

interface MobileApproval {
  id: string;
  code: string;
  agentId: string;
  tool: string;
  args: Record<string, unknown>;
  status?: string;
  reason?: string;
  note?: string;
  createdAt: string;
  timeoutMs?: number;
  expiresAt?: string;
  resolvedAt?: string;
}

interface MobileActivityResponse {
  events: AirlockActivityEvent[];
}

export function mobileApiPlugin(app: FastifyInstance, opts: MobileApiOptions): void {
  const { auditLogger, engine } = opts;

  app.post('/mobile/devices/register', async (request, reply) => {
    if (!checkRequestSecurity(request, reply, opts)) return;

    const body = (request.body ?? {}) as RegisterDeviceBody;
    if (body.platform !== 'ios') {
      reply.code(400);
      return { error: 'Only ios devices are supported' };
    }
    if (!body.pushToken || typeof body.pushToken !== 'string') {
      reply.code(400);
      return { error: 'pushToken is required' };
    }

    const token = `airlock_mobile_${randomBytes(32).toString('base64url')}`;
    const now = new Date().toISOString();
    const device = {
      id: generateId(),
      name: body.name?.trim() || 'iPhone',
      platform: 'ios' as const,
      push_token: body.pushToken,
      auth_token_hash: hashToken(token),
      created_at: now,
      updated_at: now,
    };
    auditLogger.upsertMobileDevice(device);

    return {
      id: device.id,
      name: device.name,
      platform: device.platform,
      token,
    };
  });

  app.get('/mobile/devices', async (request, reply) => {
    if (!checkRequestSecurity(request, reply, opts)) return;
    return {
      devices: auditLogger.getActiveMobileDevices().map((device) => ({
        id: device.id,
        name: device.name,
        platform: device.platform,
        createdAt: device.created_at,
        updatedAt: device.updated_at,
      })),
    };
  });

  app.delete('/mobile/devices/:id', async (request, reply) => {
    if (!checkRequestSecurity(request, reply, opts)) return;
    const { id } = request.params as { id: string };
    auditLogger.revokeMobileDevice(id);
    return { ok: true };
  });

  app.delete('/mobile/device', async (request, reply) => {
    if (!checkMobileOrAdminAuth(request, reply, opts)) return;
    const device = getDeviceFromRequest(request, auditLogger);
    if (!device) {
      reply.code(401);
      return { error: 'Unauthorized' };
    }

    auditLogger.revokeMobileDevice(device.id);
    return { ok: true };
  });

  app.put('/mobile/device', async (request, reply) => {
    if (!checkMobileOrAdminAuth(request, reply, opts)) return;
    const device = getDeviceFromRequest(request, auditLogger);
    if (!device) {
      reply.code(401);
      return { error: 'Unauthorized' };
    }

    const body = (request.body ?? {}) as UpdateDeviceBody;
    if (!body.pushToken || typeof body.pushToken !== 'string') {
      reply.code(400);
      return { error: 'pushToken is required' };
    }
    auditLogger.updateMobileDevicePushToken(device.id, body.pushToken);
    return { ok: true };
  });

  app.get('/mobile/approvals', async (request, reply) => {
    if (!checkMobileOrAdminAuth(request, reply, opts)) return;
    return {
      approvals: engine.getPending().map((entry) => {
        const createdAt = auditLogger.getHitlById(entry.id)?.created_at ?? new Date().toISOString();
        return {
          ...entry,
          ...(entry.context?.reason ? { reason: entry.context.reason } : {}),
          ...(entry.context?.note ? { note: entry.context.note } : {}),
          createdAt,
          timeoutMs: engine.timeoutMs,
          ...(engine.timeoutMs > 0
            ? { expiresAt: new Date(Date.parse(createdAt) + engine.timeoutMs).toISOString() }
            : {}),
        };
      }),
    };
  });

  app.get('/mobile/approvals/history', async (request, reply) => {
    if (!checkMobileOrAdminAuth(request, reply, opts)) return;
    const { limit } = request.query as Record<string, string | undefined>;
    const parsedLimit = limit ? Number(limit) : 50;
    return {
      approvals: auditLogger.getHitlHistory(parsedLimit).map(toMobileApproval),
    };
  });

  app.get(
    '/mobile/activity',
    async (request, reply): Promise<MobileActivityResponse | undefined> => {
      if (!checkMobileOrAdminAuth(request, reply, opts)) return;
      return {
        events: opts.activityStream?.recent() ?? [],
      };
    }
  );

  app.get('/mobile/approvals/stream', (request, reply) => {
    if (!checkMobileOrAdminAuth(request, reply, opts)) return;
    if (!opts.approvalStream) {
      reply.code(503);
      return { error: 'Approval stream is not available' };
    }
    opts.approvalStream.addClient(request, reply);
  });

  app.post('/mobile/approvals/:id/decision', async (request, reply) => {
    if (!checkMobileOrAdminAuth(request, reply, opts)) return;

    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as DecisionBody;
    const decision = body.decision;
    if (decision !== 'approved' && decision !== 'denied') {
      reply.code(400);
      return { error: 'decision must be approved or denied' };
    }

    const row = auditLogger.getHitlById(id);
    if (!row || row.status !== 'pending') {
      reply.code(404);
      return { error: 'No pending approval found' };
    }

    if (decision === 'approved') {
      const rememberResult = applyRemember(opts.configPath, row, body);
      if (rememberResult.error) {
        reply.code(rememberResult.status);
        return { error: rememberResult.error };
      }
      engine.approve(id);
    } else {
      engine.deny(id, body.reason ?? 'Denied from iOS');
    }

    return { ok: true };
  });
}

function getBearerToken(request: FastifyRequest): string | undefined {
  const header: unknown = request.headers.authorization;
  const value =
    typeof header === 'string'
      ? header
      : Array.isArray(header) && typeof header[0] === 'string'
        ? header[0]
        : undefined;
  if (!value?.startsWith('Bearer ')) return undefined;
  return value.slice('Bearer '.length);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function getDeviceFromRequest(request: FastifyRequest, auditLogger: AuditLogger) {
  const token = getBearerToken(request);
  if (!token) return undefined;
  return auditLogger.getMobileDeviceByAuthTokenHash(hashToken(token));
}

function checkMobileOrAdminAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  opts: MobileApiOptions
): boolean {
  if (getDeviceFromRequest(request, opts.auditLogger)) return true;
  return checkRequestSecurity(request, reply, opts);
}

function toMobileApproval(row: ReturnType<AuditLogger['getHitlHistory']>[number]): MobileApproval {
  const args = parseJsonObject(row.args);
  const context = parseAirlockContext(args);
  const cleanArgs = stripAirlockContext(args);
  return {
    id: row.id,
    code: row.code,
    agentId: row.agent_id,
    tool: row.tool,
    args: cleanArgs,
    status: row.status,
    ...(row.reason ? { reason: row.reason } : context.reason ? { reason: context.reason } : {}),
    ...(context.note ? { note: context.note } : {}),
    createdAt: row.created_at,
    ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
  };
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseAirlockContext(args: Record<string, unknown>): { reason?: string; note?: string } {
  const raw = args._airlock;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  return {
    ...(typeof source.reason === 'string' ? { reason: source.reason } : {}),
    ...(typeof source.note === 'string' ? { note: source.note } : {}),
  };
}

function stripAirlockContext(args: Record<string, unknown>): Record<string, unknown> {
  const { _airlock: _ignored, ...cleanArgs } = args;
  return cleanArgs;
}

function applyRemember(
  configPath: string | undefined,
  row: NonNullable<ReturnType<AuditLogger['getHitlById']>>,
  body: DecisionBody
): { status: number; error?: string } {
  if (!body.remember) return { status: 200 };
  if (body.remember !== 'always' && body.remember !== 'temporary') {
    return { status: 400, error: 'Invalid remember mode' };
  }
  if (!configPath) return { status: 400, error: 'Config mutation is not available' };
  if (
    body.duration_ms !== undefined &&
    (!Number.isFinite(body.duration_ms) || body.duration_ms <= 0)
  ) {
    return { status: 400, error: 'Invalid duration_ms' };
  }

  try {
    rememberAllow({
      configPath,
      agentId: row.agent_id,
      tool: row.tool,
      mode: body.remember as RememberAllowMode,
      ...(body.duration_ms ? { durationMs: body.duration_ms } : {}),
    });
    return { status: 200 };
  } catch {
    return { status: 500, error: 'Failed to update config' };
  }
}
