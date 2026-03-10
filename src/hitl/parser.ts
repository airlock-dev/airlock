export interface ParsedApproval {
  type: 'approve' | 'deny';
  code: string;
  reason?: string;
}

const CODE = '[A-Z0-9]{6,8}';

// Matches both bare commands ("approve ABC123") and prefixed ("hitl approve ABC123")
const APPROVE_RE = new RegExp(`(?:hitl\\s+)?approve\\s+(${CODE})\\s*$`, 'i');
const DENY_RE    = new RegExp(`(?:hitl\\s+)?deny\\s+(${CODE})(?:\\s+(.+))?\\s*$`, 'i');

export function parseApprovalCommand(text: string): ParsedApproval | null {
  const trimmed = text.trim();

  const approveMatch = trimmed.match(APPROVE_RE);
  if (approveMatch) {
    return { type: 'approve', code: approveMatch[1].toUpperCase() };
  }

  const denyMatch = trimmed.match(DENY_RE);
  if (denyMatch) {
    return { type: 'deny', code: denyMatch[1].toUpperCase(), reason: denyMatch[2] };
  }

  return null;
}
