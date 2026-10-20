import type { HitlNotification } from './providers/types.js';

function formatArgValue(v: unknown): string {
  return typeof v === 'string'
    ? v.length > 200
      ? `"${v.slice(0, 200)}..." (truncated)`
      : `"${v}"`
    : JSON.stringify(v);
}

function formatPlan(req: HitlNotification): string {
  const calls = req.plan ?? [];
  const lines = calls.map((call, index) => {
    const args = Object.entries(call.args)
      .map(([k, v]) => `${k}=${formatArgValue(v)}`)
      .join(', ');
    return `  ${index + 1}. ${call.tool}${args ? ` (${args})` : ''}`;
  });
  return [`Plan: ${calls.length} call(s), each runnable once after approval`, ...lines].join('\n');
}

function grantHint(req: HitlNotification): string | undefined {
  if (!req.grantOptions?.length) return undefined;
  const words = ['tool'];
  if (req.tier === 'read') words.push('reads');
  else if (req.tier === 'write') words.push('writes');
  words.push('provider');
  return `Also allow similar calls: approve ${req.code} 15m [${words.join('|')}]`;
}

export function formatNotification(req: HitlNotification): string {
  const timeoutMin = Math.round(req.timeoutMs / 60000);
  if (req.kind === 'plan') {
    return [
      `🔒 APPROVE PLAN? [${req.code}]`,
      ``,
      `Agent: ${req.agentId}`,
      req.context?.reason ? `Request reason: ${req.context.reason}` : undefined,
      formatPlan(req),
      ``,
      `approve ${req.code} / deny ${req.code}`,
      timeoutMin > 0 ? `Expires: ${timeoutMin}m` : undefined,
    ]
      .filter(Boolean)
      .join('\n');
  }
  const argLines = Object.entries(req.args)
    .map(([k, v]) => `  ${k}: ${formatArgValue(v)}`)
    .join('\n');

  const sandboxLines = req.sandbox
    ? [
        req.sandbox.presets.length > 0
          ? `Sandbox presets: ${req.sandbox.presets.join(', ')}`
          : undefined,
        req.sandbox.toolPresets.length > 0
          ? `Tool sandbox presets: ${req.sandbox.toolPresets.join(', ')}`
          : undefined,
        req.sandbox.summary.length > 0 ? `Sandbox: ${req.sandbox.summary.join(' | ')}` : undefined,
      ]
        .filter(Boolean)
        .join('\n')
    : '';

  return [
    `🔒 APPROVE? [${req.code}]`,
    ``,
    `Agent: ${req.agentId}`,
    `Tool:  ${req.tool}`,
    req.escalated ? `⚠️ Flagged by a security check — review individually` : undefined,
    req.context?.reason ? `Request reason: ${req.context.reason}` : undefined,
    req.context?.note ? `Request note: ${req.context.note}` : undefined,
    argLines,
    sandboxLines,
    ``,
    `approve ${req.code} / deny ${req.code}`,
    grantHint(req),
    `Expires: ${timeoutMin}m`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatBatch(requests: HitlNotification[]): string {
  if (requests.length === 1) return formatNotification(requests[0]);

  const batchCode = requests[0]?.batchCode;
  const flagged = requests.filter((r) => r.escalated || (r.kind ?? 'call') !== 'call').length;
  const header = [
    `🔒 ${requests.length} APPROVAL REQUESTS`,
    batchCode
      ? `approve all ${batchCode} / deny all ${batchCode}${flagged > 0 ? ` (approve all skips ${flagged} flagged call(s), plan(s) or question(s))` : ''}`
      : undefined,
  ]
    .filter(Boolean)
    .join('\n');
  const items = requests.map((r) => formatNotification(r)).join('\n\n---\n\n');
  return `${header}\n\n${items}`;
}
