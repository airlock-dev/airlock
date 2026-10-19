#!/usr/bin/env node
/**
 * Mock dashboard server for testing the macOS companion app.
 * Simulates Airlock's management approval API on port 4113.
 *
 * Usage:
 *   node mock-dashboard.mjs
 *   AIRLOCK_API_SECRET=dev-secret node mock-dashboard.mjs
 *
 * Then press Enter in the terminal to send a fake approval request.
 * The companion app should pick it up via SSE.
 *
 * Also mocks grants (GET/DELETE /mobile/grants, `grant` on decisions), bulk decisions
 * (POST /mobile/approvals/decisions) and batch decisions (POST /mobile/batches/:id/decision).
 */

import { createServer } from 'http';
import { randomUUID } from 'crypto';
import { createInterface } from 'readline';

const PORT = Number(process.env.PORT ?? 4113);
const REQUIRED_TOKEN = process.env.AIRLOCK_API_SECRET ?? '';
const clients = new Set();
const pending = new Map();
const grants = new Map();
let codeCounter = 0;

const TOOLS = [
  'fs_read_file',
  'shell_exec',
  'git_push',
  'db_query',
  'send_email',
  'deploy_production',
];
const AGENTS = ['claude-agent', 'coder-bot', 'deploy-agent', 'data-pipeline'];
const TOOL_META = {
  fs_read_file: { provider: 'fs', tier: 'read' },
  shell_exec: { provider: 'shell', tier: 'destructive' },
  git_push: { provider: 'git', tier: 'write' },
  db_query: { provider: 'db', tier: 'read' },
  send_email: { provider: 'gmail', tier: 'write' },
  deploy_production: { provider: 'deploy', tier: 'destructive' },
};
const TIER_RANK = { read: 0, write: 1, destructive: 2 };

/** Mirrors HitlEngine.grantOptionsFor: no options for escalated requests or non-calls. */
function grantOptionsFor(request) {
  if (request.kind !== 'call' || request.escalated || !request.provider) return [];
  const options = [{ scope: 'tool', label: `Allow ${request.tool}` }];
  if (request.tier === 'read') {
    options.push({ scope: 'tier', tier: 'read', label: `Allow read-only ${request.provider} tools` });
  } else if (request.tier === 'write') {
    options.push({
      scope: 'tier',
      tier: 'write',
      label: `Allow non-destructive ${request.provider} tools`,
    });
  }
  options.push({ scope: 'provider', label: `Allow all ${request.provider} tools` });
  return options;
}

function randomCode() {
  codeCounter++;
  const words = ['ALPHA', 'BRAVO', 'DELTA', 'ECHO', 'FOXTROT', 'GOLF'];
  const w1 = words[Math.floor(Math.random() * words.length)];
  const w2 = words[Math.floor(Math.random() * words.length)];
  return `${w1}-${w2}-${codeCounter}`;
}

function randomRequest() {
  const now = new Date();
  const timeoutMs = 30000;
  const tool = TOOLS[Math.floor(Math.random() * TOOLS.length)];
  const agent = AGENTS[Math.floor(Math.random() * AGENTS.length)];
  const meta = TOOL_META[tool];
  return {
    id: randomUUID(),
    code: randomCode(),
    agentId: agent,
    tool,
    args: {
      path: '/Users/dev/project/src/index.ts',
      command: tool === 'shell_exec' ? 'rm -rf /tmp/build && npm run build' : undefined,
      query: tool === 'db_query' ? 'SELECT * FROM users WHERE active = true' : undefined,
      content: tool === 'fs_read_file' ? 'Reading sensitive configuration file' : undefined,
    },
    timeoutMs,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + timeoutMs).toISOString(),
    kind: 'call',
    mode: 'sync',
    tier: meta.tier,
    provider: meta.provider,
    escalated: false,
  };
}

function withGrantOptions(request) {
  const options = grantOptionsFor(request);
  if (options.length > 0) request.grantOptions = options;
  else delete request.grantOptions;
  return request;
}

function sendRequest(request, label = 'Sent') {
  withGrantOptions(request);
  if (approveByGrants(request)) return;
  pending.set(request.id, request);
  broadcast({ type: 'new', request });
  console.log(`  ${label}: ${request.tool} [${request.id}] code ${request.code}`);
}

/** Several requests from one agent notified together, one of them flagged. */
function sendBatch(size = 3) {
  const batchId = randomUUID();
  const batchCode = randomCode();
  const agent = AGENTS[Math.floor(Math.random() * AGENTS.length)];
  for (let i = 0; i < size; i++) {
    const req = randomRequest();
    req.agentId = agent;
    req.batchId = batchId;
    req.batchCode = batchCode;
    req.batchSize = size;
    if (i === size - 1) req.escalated = true;
    sendRequest(req, `Sent (batch ${batchCode})`);
  }
}

function sendPlan() {
  const req = randomRequest();
  req.kind = 'plan';
  req.tool = 'airlock/plan';
  req.args = {};
  delete req.tier;
  delete req.provider;
  req.plan = [
    { tool: 'fs_write_file', args: { path: '/tmp/build/out.txt', content: 'hello' }, fingerprint: 'fp1' },
    { tool: 'shell_exec', args: { command: 'npm test' }, fingerprint: 'fp2' },
    { tool: 'git_push', args: { remote: 'origin', branch: 'feature/x' }, fingerprint: 'fp3' },
  ];
  sendRequest(req, 'Sent (plan)');
}

function grantMatches(grant, request) {
  if (grant.agentId !== request.agentId || request.kind !== 'call' || request.escalated) return false;
  if (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now()) return false;
  switch (grant.scope.kind) {
    case 'tool':
      return grant.scope.tool === request.tool;
    case 'tier':
      return (
        grant.scope.provider === request.provider &&
        TIER_RANK[request.tier] !== undefined &&
        TIER_RANK[request.tier] <= TIER_RANK[grant.scope.tier]
      );
    case 'provider':
      return grant.scope.provider === request.provider;
    default:
      return false;
  }
}

/** Returns true when an active grant covers the request (it never becomes pending). */
function approveByGrants(request) {
  for (const grant of grants.values()) {
    if (!grantMatches(grant, request)) continue;
    if (grant.usesRemaining !== undefined) {
      grant.usesRemaining -= 1;
      if (grant.usesRemaining <= 0) grants.delete(grant.id);
    }
    console.log(`  Auto-approved by grant ${grant.id}: ${request.tool}`);
    return true;
  }
  return false;
}

function createGrant(request, spec) {
  if (request.kind !== 'call' || request.escalated) {
    return { error: 'Only tool-call approvals can be turned into a grant' };
  }
  let scope;
  if (spec.scope === 'tool') scope = { kind: 'tool', tool: request.tool };
  else if (spec.scope === 'tier') {
    if (spec.tier !== 'read' && spec.tier !== 'write') return { error: 'grant.tier must be read or write' };
    scope = { kind: 'tier', tier: spec.tier, provider: request.provider };
  } else if (spec.scope === 'provider') scope = { kind: 'provider', provider: request.provider };
  else return { error: `Unknown grant scope: ${spec.scope}` };
  const now = new Date();
  const durationMs = Number(spec.duration_ms ?? spec.durationMs ?? 0);
  const grant = {
    id: randomUUID(),
    agentId: request.agentId,
    scope,
    source: 'approval',
    label: `${spec.scope} grant from ${request.tool}`,
    approvalId: request.id,
    createdAt: now.toISOString(),
    ...(durationMs > 0 ? { expiresAt: new Date(now.getTime() + durationMs).toISOString() } : {}),
    ...(spec.max_uses ? { usesRemaining: Number(spec.max_uses) } : {}),
  };
  grants.set(grant.id, grant);
  return { grant };
}

function readJson(req, callback) {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    try {
      callback(body ? JSON.parse(body) : {});
    } catch {
      callback(undefined);
    }
  });
}

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.write(msg);
    } catch {}
  }
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function normalizeInjectedRequest(request) {
  const now = new Date();
  request.id = request.id ?? randomUUID();
  request.code = request.code ?? randomCode();
  request.timeoutMs = request.timeoutMs ?? 60000;
  request.createdAt = request.createdAt ?? now.toISOString();
  request.expiresAt =
    request.expiresAt ??
    (request.timeoutMs > 0
      ? new Date(new Date(request.createdAt).getTime() + request.timeoutMs).toISOString()
      : undefined);
  return request;
}

function resolveApproval(id, action) {
  const request = pending.get(id);
  if (!request) return false;
  pending.delete(id);
  const batchPending = request.batchId
    ? Array.from(pending.values()).filter((r) => r.batchId === request.batchId).length
    : undefined;
  broadcast({
    type: 'resolved',
    id,
    code: request.code,
    action,
    result: action,
    badgeCount: pending.size,
    ...(request.batchId ? { batchId: request.batchId, batchPending } : {}),
  });
  return true;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (REQUIRED_TOKEN) {
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${REQUIRED_TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
  }

  // POST /inject with JSON body -> broadcast a custom request.
  if (req.method === 'POST' && url.pathname === '/inject') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const request = withGrantOptions(normalizeInjectedRequest(JSON.parse(body)));
        pending.set(request.id, request);
        broadcast({ type: 'new', request });
        console.log(`  Injected: ${request.tool} [${request.id}] code ${request.code}`);
        sendJson(res, 200, { id: request.id, code: request.code });
      } catch (e) {
        res.writeHead(400);
        res.end('bad json');
      }
    });
    return;
  }

  // POST /inject-activity with JSON body -> broadcast a custom activity event
  if (req.method === 'POST' && url.pathname === '/inject-activity') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const event = JSON.parse(body);
        event.id = event.id ?? randomUUID();
        event.kind = event.kind ?? 'notification';
        event.agentId = event.agentId ?? 'mock-agent';
        event.title = event.title ?? (event.kind === 'log' ? 'Mock log' : 'Mock notification');
        event.body = event.body ?? '';
        event.severity = event.severity ?? 'info';
        event.createdAt = event.createdAt ?? new Date().toISOString();
        broadcast({ type: 'activity', event });
        console.log(`  Activity: ${event.kind} ${event.title}`);
        sendJson(res, 200, { id: event.id });
      } catch (e) {
        res.writeHead(400);
        res.end('bad json');
      }
    });
    return;
  }

  if (url.pathname === '/mobile/approvals/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    clients.add(res);
    // Replay pending
    for (const r of pending.values()) {
      res.write(`data: ${JSON.stringify({ type: 'new', request: r })}\n\n`);
    }
    req.on('close', () => clients.delete(res));
    console.log(`  [sse] client connected (${clients.size} total)`);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/mobile/approvals') {
    sendJson(res, 200, { approvals: Array.from(pending.values()) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/mobile/approvals/decisions') {
    readJson(req, (body) => {
      const ids = Array.isArray(body?.ids) ? body.ids.filter((id) => typeof id === 'string') : [];
      if (ids.length === 0) {
        sendJson(res, 400, { error: 'ids must be a non-empty array of approval ids' });
        return;
      }
      if (body.decision === 'approved') {
        const approved = [];
        const skipped = [];
        for (const id of ids) {
          const request = pending.get(id);
          if (!request || request.escalated) skipped.push(id);
          else if (resolveApproval(id, 'approved')) approved.push(id);
        }
        console.log(`  Bulk approved ${approved.length}, skipped ${skipped.length}`);
        sendJson(res, 200, { ok: true, approved, skipped });
      } else if (body.decision === 'denied') {
        const denied = ids.filter((id) => resolveApproval(id, 'denied'));
        console.log(`  Bulk denied ${denied.length}`);
        sendJson(res, 200, { ok: true, denied });
      } else {
        sendJson(res, 400, { error: 'decision must be approved or denied' });
      }
    });
    return;
  }

  const batchMatch = url.pathname.match(/^\/mobile\/batches\/([^/]+)\/decision$/);
  if (req.method === 'POST' && batchMatch) {
    readJson(req, (body) => {
      const key = decodeURIComponent(batchMatch[1]);
      const members = Array.from(pending.values()).filter(
        (r) => r.batchId === key || r.batchCode === key
      );
      if (members.length === 0) {
        sendJson(res, 404, { error: 'No pending batch found' });
        return;
      }
      if (body?.decision === 'approved') {
        const approved = [];
        const skipped = [];
        for (const r of members) {
          if (r.escalated) skipped.push(r.id);
          else if (resolveApproval(r.id, 'approved')) approved.push(r.id);
        }
        sendJson(res, 200, { ok: true, approved, skipped });
      } else if (body?.decision === 'denied') {
        sendJson(res, 200, { ok: true, denied: members.filter((r) => resolveApproval(r.id, 'denied')).map((r) => r.id) });
      } else {
        sendJson(res, 400, { error: 'decision must be approved or denied' });
      }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/mobile/grants') {
    const now = Date.now();
    for (const grant of grants.values()) {
      if (grant.expiresAt && Date.parse(grant.expiresAt) <= now) grants.delete(grant.id);
    }
    sendJson(res, 200, { grants: Array.from(grants.values()) });
    return;
  }

  const grantMatch = url.pathname.match(/^\/mobile\/grants\/([^/]+)$/);
  if (req.method === 'DELETE' && grantMatch) {
    const id = decodeURIComponent(grantMatch[1]);
    if (!grants.delete(id)) {
      sendJson(res, 404, { error: 'No active grant found' });
      return;
    }
    console.log(`  Revoked grant ${id}`);
    sendJson(res, 200, { ok: true });
    return;
  }

  const decisionMatch = url.pathname.match(/^\/mobile\/approvals\/([^/]+)\/decision$/);
  if (req.method === 'POST' && decisionMatch) {
    readJson(req, (body) => {
      if (!body) {
        sendJson(res, 400, { error: 'bad json' });
        return;
      }
      const decision = body.decision;
      if (decision !== 'approved' && decision !== 'denied') {
        sendJson(res, 400, { error: 'decision must be approved or denied' });
        return;
      }
      const id = decodeURIComponent(decisionMatch[1]);
      const request = pending.get(id);
      if (!request) {
        sendJson(res, 404, { error: 'No pending approval found' });
        return;
      }
      if (decision === 'denied') {
        resolveApproval(id, 'denied');
        console.log(`  Denied: ${id}`);
        sendJson(res, 200, { ok: true });
        return;
      }

      // `grant` wins; legacy remember=temporary maps onto a tool grant.
      const spec =
        body.grant ??
        (body.remember === 'temporary' ? { scope: 'tool', duration_ms: body.duration_ms } : undefined);
      let grant;
      if (spec) {
        const created = createGrant(request, spec);
        if (created.error) {
          sendJson(res, 400, { error: created.error });
          return;
        }
        grant = created.grant;
      }
      resolveApproval(id, 'approved');
      const approved = [id];
      if (grant) {
        for (const other of Array.from(pending.values())) {
          if (grantMatches(grant, other) && resolveApproval(other.id, 'approved')) approved.push(other.id);
        }
      }
      console.log(`  Approved: ${id}${grant ? ` (+grant ${grant.scope.kind}, ${approved.length - 1} more)` : ''}`);
      sendJson(res, 200, { ok: true, approved, ...(grant ? { grant } : {}) });
    });
    return;
  }

  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', pending: pending.size }));
    return;
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', pendingApprovals: pending.size }));
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\nMock Airlock dashboard running on http://127.0.0.1:${PORT}`);
  if (REQUIRED_TOKEN) {
    console.log('  bearer auth enabled; use AIRLOCK_API_SECRET as the companion token');
  }
  console.log(`\nCommands:`);
  console.log(`  [Enter]      -> send a random approval request`);
  console.log(`  "burst"     → send 3 requests at once`);
  console.log(`  "timeout"   → send a request with 10s timeout`);
  console.log(`  "batch"     → send 3 batched requests from one agent (last one flagged)`);
  console.log(`  "plan"      → send a plan approval with 3 calls`);
  console.log(`  "flagged"   → send an escalated request`);
  console.log(`  "grants"    → list active grants`);
  console.log(`  "q" / Ctrl-C → quit\n`);
});

// In non-TTY mode (e.g. nohup), skip readline — use POST /inject instead
if (!process.stdin.isTTY) {
  console.log('  (non-interactive mode: use POST /inject to send requests)\n');
} else {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  rl.on('line', (input) => {
    const cmd = input.trim().toLowerCase();

    if (cmd === 'q' || cmd === 'quit') {
      console.log('Shutting down...');
      server.close();
      process.exit(0);
    }

    if (cmd === 'burst') {
      for (let i = 0; i < 3; i++) sendRequest(randomRequest());
      return;
    }

    if (cmd === 'timeout') {
      const req = randomRequest();
      req.timeoutMs = 10000;
      req.expiresAt = new Date(Date.now() + req.timeoutMs).toISOString();
      sendRequest(req, 'Sent (10s timeout)');
      return;
    }

    if (cmd === 'batch') {
      sendBatch();
      return;
    }

    if (cmd === 'plan') {
      sendPlan();
      return;
    }

    if (cmd === 'flagged') {
      const req = randomRequest();
      req.escalated = true;
      sendRequest(req, 'Sent (flagged)');
      return;
    }

    if (cmd === 'grants') {
      console.log(grants.size ? Array.from(grants.values()) : '  (no active grants)');
      return;
    }

    // Default: send one request
    sendRequest(randomRequest());
  });
} // end TTY-only block
