import { createServer } from 'http';
import type { Server } from 'http';
import { childLogger } from '../../util/logger.js';
import type { HitlProvider, HitlNotification, ApprovalApi } from './types.js';

const log = childLogger('hitl-dashboard');

export interface DashboardHitlConfig {
  port: number;
}

export class DashboardHitlProvider implements HitlProvider {
  private server?: Server;
  private clients = new Set<{ write: (data: string) => boolean }>();
  private pending = new Map<string, HitlNotification>();

  constructor(
    private config: DashboardHitlConfig,
    private approvalApi: ApprovalApi,
  ) {}

  async init(): Promise<void> {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${this.config.port}`);

      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(DASHBOARD_HTML);
        return;
      }

      if (url.pathname === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        this.clients.add(res);
        // Send current pending requests
        for (const req of this.pending.values()) {
          res.write(`data: ${JSON.stringify({ type: 'new', request: req })}\n\n`);
        }
        req.on('close', () => this.clients.delete(res));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/approve') {
        const code = url.searchParams.get('code');
        if (code) {
          this.pending.delete(code);
          this.approvalApi.approve(code);
          this.broadcast({ type: 'resolved', code, action: 'approved' });
          log.info({ code }, 'Approved via dashboard');
        }
        res.writeHead(200);
        res.end('ok');
        return;
      }

      if (req.method === 'POST' && url.pathname === '/deny') {
        const code = url.searchParams.get('code');
        if (code) {
          this.pending.delete(code);
          this.approvalApi.deny(code, 'Denied via dashboard');
          this.broadcast({ type: 'resolved', code, action: 'denied' });
          log.info({ code }, 'Denied via dashboard');
        }
        res.writeHead(200);
        res.end('ok');
        return;
      }

      res.writeHead(404);
      res.end('not found');
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.config.port, '127.0.0.1', () => {
        log.info({ port: this.config.port }, 'HITL dashboard listening');
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const client of this.clients) {
      try { (client as any).end(); } catch {}
    }
    this.clients.clear();
    await new Promise<void>((resolve) => {
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });
  }

  async notify(requests: HitlNotification[]): Promise<void> {
    for (const req of requests) {
      this.pending.set(req.code, req);
      this.broadcast({ type: 'new', request: req });
    }
  }

  private broadcast(data: unknown): void {
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      try { client.write(msg); } catch {}
    }
  }
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Airlock</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0d1117; color: #c9d1d9; padding: 20px; }
  h1 { font-size: 18px; margin-bottom: 16px; color: #58a6ff; }
  #empty { color: #484f58; font-style: italic; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-bottom: 12px; }
  .card.approved { border-color: #238636; opacity: 0.5; }
  .card.denied { border-color: #da3633; opacity: 0.5; }
  .tool { font-weight: 600; color: #f0883e; font-size: 15px; }
  .agent { color: #8b949e; font-size: 13px; margin-top: 2px; }
  .args { font-family: "SF Mono", Monaco, monospace; font-size: 12px; background: #0d1117; border-radius: 4px; padding: 8px; margin: 8px 0; white-space: pre-wrap; word-break: break-all; color: #8b949e; max-height: 120px; overflow-y: auto; }
  .code { font-family: "SF Mono", Monaco, monospace; font-size: 11px; color: #484f58; margin-bottom: 8px; }
  .actions { display: flex; gap: 8px; }
  .btn { border: none; padding: 6px 16px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; }
  .btn-approve { background: #238636; color: #fff; }
  .btn-approve:hover { background: #2ea043; }
  .btn-deny { background: #21262d; color: #f85149; border: 1px solid #da3633; }
  .btn-deny:hover { background: #da3633; color: #fff; }
  .status { font-size: 12px; font-weight: 600; margin-top: 8px; }
  .status.approved { color: #3fb950; }
  .status.denied { color: #f85149; }
</style>
</head>
<body>
<h1>Airlock Approvals</h1>
<div id="list"><div id="empty">No pending requests</div></div>
<script>
const list = document.getElementById('list');
const empty = document.getElementById('empty');
const cards = new Map();

function render(req) {
  const el = document.createElement('div');
  el.className = 'card';
  el.id = 'card-' + req.code;
  const args = JSON.stringify(req.args, null, 2);
  el.innerHTML = \`
    <div class="tool">\${esc(req.tool)}</div>
    <div class="agent">agent: \${esc(req.agentId)}</div>
    <div class="args">\${esc(args)}</div>
    <div class="code">\${req.code}</div>
    <div class="actions">
      <button class="btn btn-approve" onclick="act('approve','\${req.code}')">Approve</button>
      <button class="btn btn-deny" onclick="act('deny','\${req.code}')">Deny</button>
    </div>
  \`;
  cards.set(req.code, el);
  list.prepend(el);
  empty.style.display = 'none';
}

function act(action, code) {
  fetch('/' + action + '?code=' + code, { method: 'POST' });
  const el = cards.get(code);
  if (el) {
    el.querySelector('.actions').innerHTML = '<div class="status ' + action + (action === 'approve' ? 'd' : '') + '">' + action + 'd</div>';
    el.classList.add(action === 'approve' ? 'approved' : 'denied');
  }
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

if ('Notification' in window) Notification.requestPermission();

const es = new EventSource('/events');
es.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'new') {
    render(msg.request);
    if (Notification.permission === 'granted') {
      new Notification('Airlock: ' + msg.request.tool, {
        body: 'agent: ' + msg.request.agentId + '\\n' + msg.request.code,
        tag: msg.request.code,
      });
    }
  }
  if (msg.type === 'resolved') {
    const el = cards.get(msg.code);
    if (el) {
      el.querySelector('.actions').innerHTML = '<div class="status ' + (msg.action === 'approved' ? 'approved' : 'denied') + '">' + msg.action + '</div>';
      el.classList.add(msg.action);
    }
  }
};
</script>
</body>
</html>`;
