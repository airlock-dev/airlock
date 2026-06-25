import { randomInt, randomUUID } from 'crypto';

const APPROVAL_CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const APPROVAL_CODE_LENGTH = 8; // 36^8 ≈ 2.8 trillion

/** Generate an 8-char uppercase alphanumeric HITL approval code (no modular bias) */
export function generateApprovalCode(): string {
  let code = '';
  for (let i = 0; i < APPROVAL_CODE_LENGTH; i++) {
    code += APPROVAL_CODE_CHARS[randomInt(APPROVAL_CODE_CHARS.length)];
  }
  return code;
}

/** Generate a unique request ID. */
export function generateId(): string {
  return randomUUID();
}
