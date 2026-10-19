import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { GrantSpecError, type HitlEngine } from './engine.js';
import type { Grant, GrantScope, GrantSpec } from './grants.js';

/** Request-body parsing and routes shared by the management API and the mobile API. */

type Body = Record<string, unknown>;

function isRecord(value: unknown): value is Body {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a field accepting both snake_case and camelCase. */
function field(body: Body, snake: string, camel: string): unknown {
  return body[snake] ?? body[camel];
}

function positiveInteger(value: unknown): number | undefined | null {
  const n = positiveNumber(value);
  if (n === undefined || n === null) return n;
  return Number.isInteger(n) ? n : null;
}

function positiveNumber(value: unknown): number | undefined | null {
  if (value === undefined || value === null) return undefined;
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

/** Parse `{ scope, tier?, profile?, duration_ms?, max_uses?, session_only?, same_provider? }`. */
export function parseGrantSpecInput(raw: unknown): { spec?: GrantSpec; error?: string } {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) return { error: 'grant must be an object' };
  const scope = raw.scope;
  if (scope !== 'tool' && scope !== 'tier' && scope !== 'provider' && scope !== 'profile') {
    return { error: 'grant.scope must be tool, tier, provider or profile' };
  }
  const tier = raw.tier;
  if (tier !== undefined && tier !== 'read' && tier !== 'write') {
    return { error: 'grant.tier must be read or write' };
  }
  const durationMs = positiveNumber(field(raw, 'duration_ms', 'durationMs'));
  if (durationMs === null) return { error: 'grant.duration_ms must be a positive number' };
  const maxUses = positiveInteger(field(raw, 'max_uses', 'maxUses'));
  if (maxUses === null) return { error: 'grant.max_uses must be a whole number of at least 1' };
  const profile = raw.profile;
  if (profile !== undefined && typeof profile !== 'string') {
    return { error: 'grant.profile must be a string' };
  }
  const sessionOnly = field(raw, 'session_only', 'sessionOnly');
  const sameProvider = field(raw, 'same_provider', 'sameProvider');
  return {
    spec: {
      scope,
      ...(tier ? { tier } : {}),
      ...(profile ? { profile } : {}),
      ...(durationMs ? { durationMs } : {}),
      ...(maxUses !== undefined ? { maxUses } : {}),
      ...(sessionOnly === true ? { sessionOnly: true } : {}),
      ...(sameProvider === false ? { sameProvider: false } : {}),
    },
  };
}

/** Legacy `remember=temporary` from older companions maps onto a tool grant. */
export function rememberToGrantSpec(
  remember: unknown,
  durationMs: unknown
): { spec?: GrantSpec; error?: string } {
  if (remember !== 'temporary') return {};
  const parsed = positiveNumber(durationMs);
  if (parsed === null) return { error: 'Invalid duration_ms' };
  return { spec: { scope: 'tool', ...(parsed ? { durationMs: parsed } : {}) } };
}

/** Parse an operator pre-grant: `{ agent, scope: { kind, … }, duration_ms?, max_uses? }`. */
export function parseOperatorGrantInput(raw: unknown): {
  agentId?: string;
  scope?: GrantScope;
  durationMs?: number;
  maxUses?: number;
  error?: string;
} {
  if (!isRecord(raw)) return { error: 'body must be an object' };
  const agentId = field(raw, 'agent', 'agentId');
  if (typeof agentId !== 'string' || !agentId) return { error: 'agent is required' };
  const scopeRaw = raw.scope;
  if (!isRecord(scopeRaw)) return { error: 'scope must be an object with a kind' };
  let scope: GrantScope;
  const str = (key: string) => (typeof scopeRaw[key] === 'string' ? scopeRaw[key] : '');
  switch (scopeRaw.kind) {
    case 'tool':
      if (!str('tool')) return { error: 'scope.tool is required' };
      scope = { kind: 'tool', tool: str('tool') };
      break;
    case 'tier':
      if (scopeRaw.tier !== 'read' && scopeRaw.tier !== 'write') {
        return { error: 'scope.tier must be read or write' };
      }
      scope = {
        kind: 'tier',
        tier: scopeRaw.tier,
        ...(str('provider') ? { provider: str('provider') } : {}),
      };
      break;
    case 'provider':
      if (!str('provider')) return { error: 'scope.provider is required' };
      scope = { kind: 'provider', provider: str('provider') };
      break;
    case 'profile':
      if (!str('profile')) return { error: 'scope.profile is required' };
      scope = { kind: 'profile', profile: str('profile') };
      break;
    default:
      return { error: 'scope.kind must be tool, tier, provider or profile' };
  }
  const durationMs = positiveNumber(field(raw, 'duration_ms', 'durationMs'));
  if (durationMs === null) return { error: 'duration_ms must be a positive number' };
  const maxUses = positiveInteger(field(raw, 'max_uses', 'maxUses'));
  if (maxUses === null) return { error: 'max_uses must be a whole number of at least 1' };
  return {
    agentId,
    scope,
    ...(durationMs ? { durationMs } : {}),
    ...(maxUses !== undefined ? { maxUses } : {}),
  };
}

export function serializeGrant(grant: Grant): Record<string, unknown> {
  return {
    id: grant.id,
    agentId: grant.agentId,
    scope: grant.scope,
    source: grant.source,
    ...(grant.label ? { label: grant.label } : {}),
    ...(grant.sessionId ? { sessionId: grant.sessionId } : {}),
    ...(grant.approvalId ? { approvalId: grant.approvalId } : {}),
    createdAt: grant.createdAt,
    ...(grant.expiresAt ? { expiresAt: grant.expiresAt } : {}),
    ...(grant.usesRemaining !== undefined ? { usesRemaining: grant.usesRemaining } : {}),
  };
}

/** Approve one request, optionally widening it into a grant. Maps grant errors to 400. */
export function approveWithGrant(
  engine: HitlEngine,
  id: string,
  spec: GrantSpec | undefined,
  reply: FastifyReply
): Record<string, unknown> {
  try {
    const outcome = engine.approve(id, spec ? { grant: spec } : undefined);
    return {
      ok: true,
      approved: outcome?.approved ?? [id],
      ...(outcome?.grant ? { grant: serializeGrant(outcome.grant) } : {}),
    };
  } catch (err) {
    if (err instanceof GrantSpecError) {
      reply.code(400);
      return { error: err.message };
    }
    throw err;
  }
}

type AuthCheck = (request: FastifyRequest, reply: FastifyReply) => boolean;

/**
 * Bulk decisions, batch decisions and grant management, mounted under `prefix`
 * (`/hitl` on the management API, `/mobile` on the mobile API).
 */
export function registerGrantRoutes(
  app: FastifyInstance,
  engine: HitlEngine,
  prefix: string,
  authorize: AuthCheck = () => true
): void {
  // Decide an explicit list of approvals at once. Explicit ids mean "approve all" only ever covers
  // what the operator was looking at.
  app.post(`${prefix}/approvals/decisions`, async (request, reply) => {
    if (!authorize(request, reply)) return;
    const body = isRecord(request.body) ? request.body : {};
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((id): id is string => typeof id === 'string')
      : [];
    if (ids.length === 0) {
      reply.code(400);
      return { error: 'ids must be a non-empty array of approval ids' };
    }
    if (body.decision === 'approved') {
      const outcome = engine.approveMany(ids, {
        includeEscalated: field(body, 'include_flagged', 'includeFlagged') === true,
      });
      return { ok: true, approved: outcome.approved, skipped: outcome.skipped };
    }
    if (body.decision === 'denied') {
      const reason = typeof body.reason === 'string' ? body.reason : 'Denied in bulk';
      return { ok: true, denied: engine.denyMany(ids, reason) };
    }
    reply.code(400);
    return { error: 'decision must be approved or denied' };
  });

  // Decide a notification batch (by batch id or batch code).
  app.post(`${prefix}/batches/:batch/decision`, async (request, reply) => {
    if (!authorize(request, reply)) return;
    const { batch } = request.params as { batch: string };
    const body = isRecord(request.body) ? request.body : {};
    if (!engine.hasBatch(batch)) {
      reply.code(404);
      return { error: 'No pending batch found' };
    }
    if (body.decision === 'approved') {
      const outcome = engine.approveBatch(batch);
      return { ok: true, approved: outcome?.approved ?? [], skipped: outcome?.skipped ?? [] };
    }
    if (body.decision === 'denied') {
      const reason = typeof body.reason === 'string' ? body.reason : 'Denied as a batch';
      return { ok: true, denied: engine.denyBatch(batch, reason) ?? [] };
    }
    reply.code(400);
    return { error: 'decision must be approved or denied' };
  });

  app.get(`${prefix}/grants`, async (request, reply) => {
    if (!authorize(request, reply)) return;
    const { agent } = request.query as { agent?: string };
    return { grants: engine.listGrants(agent).map(serializeGrant) };
  });

  // Pre-approve without waiting for a request: "let research read gmail for the next hour".
  app.post(`${prefix}/grants`, async (request, reply) => {
    if (!authorize(request, reply)) return;
    const parsed = parseOperatorGrantInput(request.body);
    if (parsed.error || !parsed.agentId || !parsed.scope) {
      reply.code(400);
      return { error: parsed.error ?? 'Invalid grant' };
    }
    try {
      const grant = engine.createOperatorGrant({
        agentId: parsed.agentId,
        scope: parsed.scope,
        ...(parsed.durationMs ? { durationMs: parsed.durationMs } : {}),
        ...(parsed.maxUses ? { maxUses: parsed.maxUses } : {}),
      });
      return { ok: true, grant: serializeGrant(grant) };
    } catch (err) {
      if (err instanceof GrantSpecError) {
        reply.code(400);
        return { error: err.message };
      }
      throw err;
    }
  });

  app.delete(`${prefix}/grants/:id`, async (request, reply) => {
    if (!authorize(request, reply)) return;
    const { id } = request.params as { id: string };
    if (!engine.revokeGrant(id)) {
      reply.code(404);
      return { error: 'No active grant found' };
    }
    return { ok: true };
  });
}
