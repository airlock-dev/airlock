import type { HitlNotification } from './providers/types.js';

export function formatNotification(req: HitlNotification): string {
  const timeoutMin = Math.round(req.timeoutMs / 60000);
  const argLines = Object.entries(req.args)
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

export function formatBatch(requests: HitlNotification[]): string {
  if (requests.length === 1) return formatNotification(requests[0]);

  const header = `🔒 ${requests.length} APPROVAL REQUESTS`;
  const items = requests.map((r) => formatNotification(r)).join('\n\n---\n\n');
  return `${header}\n\n${items}`;
}
