import { createHash, timingSafeEqual } from 'crypto';
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

export function isOriginAllowed(
  origin: string | undefined,
  allowedOrigins: string[] = []
): boolean {
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

/** Lowercase hex SHA-256 digest of a string. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface AgentCredential {
  token?: string;
  token_sha256?: string;
}

/** True when the agent has its own bearer credential (plaintext token or SHA-256 hash). */
export function hasAgentCredential(agent: AgentCredential): boolean {
  return Boolean(agent.token) || Boolean(agent.token_sha256);
}

/**
 * Check an Authorization header against an agent's credential. The header must be exactly
 * `Bearer <token>`. The presented value is hashed and compared against the configured digest
 * (the `token_sha256` value, or the hash of the plaintext `token`) in constant time.
 */
export function agentTokenMatches(agent: AgentCredential, authorizationHeader: string): boolean {
  const expectedHex = agent.token_sha256 || (agent.token ? sha256Hex(agent.token) : undefined);
  if (!expectedHex) return false;
  const prefix = 'Bearer ';
  if (!authorizationHeader.startsWith(prefix)) return false;
  const presentedHex = sha256Hex(authorizationHeader.slice(prefix.length));
  return constantTimeEqual(presentedHex, expectedHex.toLowerCase());
}

/**
 * Enforce an agent's own bearer credential, replying 401 on mismatch/missing.
 * Callers must check hasAgentCredential() first.
 */
export function checkAgentBearerAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  agent: AgentCredential
): boolean {
  if (!agentTokenMatches(agent, getHeader(request.headers.authorization))) {
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
