import type { HitlNotification } from './providers/types.js';

function formatArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => {
      const val =
        typeof v === 'string'
          ? v.length > 200
            ? `"${v.slice(0, 200)}..." (truncated)`
            : `"${v}"`
          : JSON.stringify(v);
      return `  ${k}: ${val}`;
    })
    .join('\n');
}

export function formatNotification(req: HitlNotification): string {
  if (req.notifyOnly) return formatNotifyEvent(req);

  const timeoutMin = Math.round(req.timeoutMs / 60000);
  const argLines = formatArgs(req.args);

  return [
    `🔒 APPROVE? [${req.code}]`,
    ``,
    `Agent: ${req.agentId}`,
    `Tool:  ${req.tool}`,
    argLines,
    ``,
    `approve ${req.code} / deny ${req.code}`,
    `Expires: ${timeoutMin}m`,
  ].join('\n');
}

/** Format a notify-only event (informational, no approval needed). */
export function formatNotifyEvent(req: HitlNotification): string {
  const argLines = formatArgs(req.args);

  return [
    `📋 AUTO-APPROVED (notify)`,
    ``,
    `Agent: ${req.agentId}`,
    `Tool:  ${req.tool}`,
    argLines,
  ].join('\n');
}

export function formatBatch(requests: HitlNotification[]): string {
  if (requests.length === 1) return formatNotification(requests[0]);

  // Separate notify-only from approval requests
  const approvals = requests.filter((r) => !r.notifyOnly);
  const notifies = requests.filter((r) => r.notifyOnly);

  const parts: string[] = [];

  if (approvals.length > 0) {
    const header = `🔒 ${approvals.length} APPROVAL REQUEST${approvals.length > 1 ? 'S' : ''}`;
    const items = approvals.map((r) => formatNotification(r)).join('\n\n---\n\n');
    parts.push(`${header}\n\n${items}`);
  }

  if (notifies.length > 0) {
    const header = `📋 ${notifies.length} AUTO-APPROVED (notify)`;
    const items = notifies.map((r) => formatNotifyEvent(r)).join('\n\n---\n\n');
    parts.push(`${header}\n\n${items}`);
  }

  return parts.join('\n\n===\n\n');
}
