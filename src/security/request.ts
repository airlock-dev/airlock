import { timingSafeEqual } from 'crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export interface RequestSecurityOptions {
  secret?: string;
  authRequired?: boolean;
  allowedOrigins?: string[];
  getRequestSecurity?: () => RequestSecurityOptions;
}

export function currentRequestSecurity(opts: RequestSecurityOptions): RequestSecurityOptions {
  return opts.getRequestSecurity?.() ?? opts;
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function getHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function normalizeOrigin(origin: string): string {
  return origin.endsWith('/') ? origin.slice(0, -1) : origin;
}

export function isOriginAllowed(origin: string | undefined, allowedOrigins: string[] = []): boolean {
  if (!origin) return true;
  const normalized = normalizeOrigin(origin);
  return allowedOrigins.map(normalizeOrigin).includes(normalized);
}

export function checkOrigin(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedOrigins: string[] = []
): boolean {
  const origin = getHeader(request.headers.origin);
  if (isOriginAllowed(origin, allowedOrigins)) return true;

  reply.status(403).send({ error: 'Origin not allowed' });
  return false;
}

export function checkBearerAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  opts: { secret?: string; authRequired?: boolean }
): boolean {
  if (!opts.secret) {
    if (!opts.authRequired) return true;
    reply.status(401).send({ error: 'Unauthorized' });
    return false;
  }

  const auth = getHeader(request.headers.authorization);
  if (!constantTimeEqual(auth, `Bearer ${opts.secret}`)) {
    reply.status(401).send({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

export function checkRequestSecurity(
  request: FastifyRequest,
  reply: FastifyReply,
  opts: RequestSecurityOptions
): boolean {
  const current = currentRequestSecurity(opts);
  if (!checkOrigin(request, reply, current.allowedOrigins)) return false;
  return checkBearerAuth(request, reply, current);
}
