import { parseDuration, type GrantSpec } from './grants.js';
import type { ApprovalApi } from './providers/types.js';

export interface ParsedApproval {
  type: 'approve' | 'deny';
  code: string;
  reason?: string;
  /** "approve CODE 15m reads": also allow similar calls for a while. */
  grant?: GrantSpec;
}

const CODE = '[A-Z0-9]{6,8}';

// Matches bare commands ("approve ABC123"), prefixed ("hitl approve ABC123"), batch codes
// ("approve all ABC123"), and grants ("approve ABC123 15m", "approve ABC123 for 2h reads").
const APPROVE_RE = new RegExp(
  `(?:hitl\\s+)?approve\\s+(?:all\\s+)?(${CODE})(?:\\s+(?:for\\s+)?(\\S+))?(?:\\s+(\\S+))?\\s*$`,
  'i'
);
const DENY_RE = new RegExp(`(?:hitl\\s+)?deny\\s+(?:all\\s+)?(${CODE})(?:\\s+(.+))?\\s*$`, 'i');

const SCOPE_WORDS: Record<string, Pick<GrantSpec, 'scope' | 'tier'>> = {
  tool: { scope: 'tool' },
  reads: { scope: 'tier', tier: 'read' },
  read: { scope: 'tier', tier: 'read' },
  writes: { scope: 'tier', tier: 'write' },
  write: { scope: 'tier', tier: 'write' },
  provider: { scope: 'provider' },
  server: { scope: 'provider' },
};

function parseGrant(first?: string, second?: string): GrantSpec | null | undefined {
  const words = [first, second].filter((word): word is string => Boolean(word));
  if (words.length === 0) return undefined;
  let durationMs: number | undefined;
  let scope: Pick<GrantSpec, 'scope' | 'tier'> | undefined;
  for (const word of words) {
    const lower = word.toLowerCase();
    if (SCOPE_WORDS[lower] && !scope) scope = SCOPE_WORDS[lower];
    else if (durationMs === undefined && parseDuration(word) !== undefined)
      durationMs = parseDuration(word);
    else return null; // unrecognised trailing word: not an approval command
  }
  return { ...(scope ?? { scope: 'tool' }), ...(durationMs ? { durationMs } : {}) };
}

export function parseApprovalCommand(text: string): ParsedApproval | null {
  const trimmed = text.trim();

  const approveMatch = trimmed.match(APPROVE_RE);
  if (approveMatch) {
    const grant = parseGrant(approveMatch[2], approveMatch[3]);
    if (grant === null) return null;
    return { type: 'approve', code: approveMatch[1].toUpperCase(), ...(grant ? { grant } : {}) };
  }

  const denyMatch = trimmed.match(DENY_RE);
  if (denyMatch) {
    return { type: 'deny', code: denyMatch[1].toUpperCase(), reason: denyMatch[2] };
  }

  return null;
}

/**
 * Apply a parsed chat command. A grant the engine rejects (e.g. on a call a detector flagged)
 * still approves the request itself — the operator clearly said yes to that one — but nothing wider.
 */
export function applyApprovalCommand(
  api: ApprovalApi,
  parsed: ParsedApproval,
  onGrantRejected?: (err: unknown) => void
): void {
  if (parsed.type === 'deny') {
    api.denyByCode(parsed.code, parsed.reason);
    return;
  }
  if (!parsed.grant) {
    api.approveByCode(parsed.code);
    return;
  }
  try {
    api.approveByCode(parsed.code, { grant: parsed.grant });
  } catch (err) {
    onGrantRejected?.(err);
    api.approveByCode(parsed.code);
  }
}
