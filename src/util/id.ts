import { randomBytes } from 'crypto';

/** Generate a 6-char uppercase alphanumeric HITL approval code */
export function generateApprovalCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = randomBytes(6);
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

/** Generate a unique request ID (UUID-like) */
export function generateId(): string {
  return randomBytes(16).toString('hex');
}
