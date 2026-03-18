import { createServer } from 'http';
import type { Server } from 'http';
import { childLogger } from '../../util/logger.js';
import { VERSION } from '../../version.js';
import type { HitlProvider, HitlNotification, ApprovalApi } from './types.js';

const log = childLogger('hitl-dashboard');

let latestVersionCache: { version: string; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface DashboardHitlConfig {
  port: number;
}

export class DashboardHitlProvider implements HitlProvider {
  private server?: Server;
  private clients = new Set<{ write: (data: string) => boolean; end: () => void }>();
  private pending = new Map<string, HitlNotification>();

  constructor(
    private config: DashboardHitlConfig,
    private approvalApi: ApprovalApi
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
          Connection: 'keep-alive',
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

      if (req.method === 'GET' && url.pathname === '/version') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: VERSION }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/version/latest') {
        const now = Date.now();
        if (latestVersionCache && now - latestVersionCache.fetchedAt < CACHE_TTL_MS) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ latest: latestVersionCache.version }));
          return;
        }
        fetch('https://registry.npmjs.org/airlock-bot/latest')
          .then((r) => r.json() as Promise<{ version: string }>)
          .then((data) => {
            latestVersionCache = { version: data.version, fetchedAt: now };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ latest: data.version }));
          })
          .catch((err) => {
            log.warn({ err }, 'Failed to fetch latest version from npm');
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to fetch latest version' }));
          });
        return;
      }

      res.writeHead(404);
      res.end('not found');
    });

    await new Promise<void>((resolve) => {
      this.server!.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          log.warn(
            { port: this.config.port },
            'Dashboard port in use — running without dashboard UI'
          );
          this.server = undefined;
          resolve();
        } else {
          log.error({ err }, 'Dashboard server error');
          resolve(); // don't crash the process
        }
      });
      this.server!.listen(this.config.port, '127.0.0.1', () => {
        log.info({ port: this.config.port }, 'HITL dashboard listening');
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const client of this.clients) {
      try {
        client.end();
      } catch {
        /* swallow */
      }
    }
    this.clients.clear();
    await new Promise<void>((resolve) => {
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });
  }

  notify(requests: HitlNotification[]): Promise<void> {
    for (const req of requests) {
      this.pending.set(req.code, req);
      this.broadcast({ type: 'new', request: req });
    }
    return Promise.resolve();
  }

  private broadcast(data: unknown): void {
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(msg);
      } catch {
        /* swallow */
      }
    }
  }
}

const DASHBOARD_HTML =
  `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Airlock</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0d1117; color: #c9d1d9; padding: 20px; }
  header { display: flex; align-items: center; margin-bottom: 16px; gap: 12px; }
  h1 { font-size: 18px; color: #58a6ff; }
  .settings-btn { background: none; border: 1px solid #30363d; border-radius: 6px; color: #8b949e; cursor: pointer; padding: 4px 8px; font-size: 12px; }
  .settings-btn:hover { border-color: #58a6ff; color: #c9d1d9; }
  #settings { display: none; background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px 16px; margin-bottom: 12px; }
  #settings.open { display: block; }
  #settings label { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #c9d1d9; cursor: pointer; margin-bottom: 6px; }
  #settings label:last-child { margin-bottom: 0; }
  #empty { color: #484f58; font-style: italic; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-bottom: 12px; cursor: pointer; transition: border-color 0.15s; }
  .card:hover { border-color: #58a6ff; }
  .card.approved { border-color: #238636; opacity: 0.5; }
  .card.denied { border-color: #da3633; opacity: 0.5; }
  .card .actions { position: relative; z-index: 2; }
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
  .btn kbd { display: inline-block; background: rgba(255,255,255,0.1); border-radius: 3px; padding: 0 4px; font-size: 11px; font-family: inherit; margin-left: 6px; opacity: 0.7; }
  .status { font-size: 12px; font-weight: 600; margin-top: 8px; }
  .status.approved { color: #3fb950; }
  .status.denied { color: #f85149; }
  .version-info { margin-top: 12px; font-size: 12px; color: #484f58; }
  .version-info .current { color: #8b949e; }
  .version-info .update-available { color: #f0883e; margin-top: 4px; }
  .version-info .update-available code { background: #21262d; padding: 2px 6px; border-radius: 4px; font-size: 11px; }
  .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 100; justify-content: center; align-items: center; }
  .modal-overlay.open { display: flex; }
  .modal { background: #161b22; border: 1px solid #30363d; border-radius: 10px; width: 90vw; max-width: 600px; max-height: 80vh; display: flex; flex-direction: column; animation: modalIn 0.15s ease-out; }
  @keyframes modalIn { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }
  .modal-header { display: flex; justify-content: space-between; align-items: center; padding: 16px; border-bottom: 1px solid #30363d; }
  .modal-header .tool { margin: 0; }
  .modal-close { background: none; border: none; color: #8b949e; font-size: 20px; cursor: pointer; padding: 4px 8px; border-radius: 4px; }
  .modal-close:hover { background: #21262d; color: #c9d1d9; }
  .modal-body { padding: 16px; overflow-y: auto; flex: 1; }
  .modal-body .detail-label { font-size: 11px; color: #484f58; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 12px; margin-bottom: 4px; }
  .modal-body .detail-label:first-child { margin-top: 0; }
  .modal-body .detail-value { font-size: 13px; color: #c9d1d9; }
  .modal-body .detail-value.mono { font-family: "SF Mono", Monaco, monospace; font-size: 12px; color: #8b949e; }
  .modal-body .args-full { max-height: 50vh; overflow-y: auto; }
  .modal-body .arg-entry { margin-bottom: 10px; }
  .modal-body .arg-entry:last-child { margin-bottom: 0; }
  .modal-body .arg-key { font-family: "SF Mono", Monaco, monospace; font-size: 12px; color: #79c0ff; margin-bottom: 4px; }
  .modal-body .arg-val { font-family: "SF Mono", Monaco, monospace; font-size: 12px; background: #0d1117; border-radius: 4px; padding: 10px; white-space: pre-wrap; word-break: break-word; color: #c9d1d9; overflow-x: auto; }
  .modal-body .arg-val pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
  .modal-body .arg-val code.hljs { background: transparent; padding: 0; }
  .modal-footer { padding: 12px 16px; border-top: 1px solid #30363d; display: flex; gap: 8px; }
  .modal-footer .status { margin: 0; padding: 6px 0; }
</style>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github-dark.min.css" crossorigin="anonymous" referrerpolicy="no-referrer">
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js" crossorigin="anonymous" referrerpolicy="no-referrer"></scr` +
  `ipt>
</head>
<body>
<header>
  <h1>Airlock Approvals</h1>
  <button class="settings-btn" onclick="document.getElementById('settings').classList.toggle('open')">Settings</button>
</header>
<div id="settings">
  <label><input type="checkbox" id="notifs" checked> Browser notifications</label>
  <label><input type="checkbox" id="sound" checked> Sound</label>
  <div class="version-info" id="version-info"></div>
</div>
<div id="list"><div id="empty">No pending requests</div></div>
<div class="modal-overlay" id="modal-overlay" onclick="closeModal(event)">
  <div class="modal" onclick="event.stopPropagation()">
    <div class="modal-header">
      <div class="tool" id="modal-tool"></div>
      <button class="modal-close" onclick="closeModal()">&times;</button>
    </div>
    <div class="modal-body" id="modal-body"></div>
    <div class="modal-footer" id="modal-footer"></div>
  </div>
</div>
<script>
var list = document.getElementById('list');
var empty = document.getElementById('empty');
var cards = new Map();
var requestData = new Map();

// Settings — persisted in localStorage
var notifsEl = document.getElementById('notifs');
var soundEl = document.getElementById('sound');

notifsEl.checked = localStorage.getItem('airlock:notifs') === 'true';
soundEl.checked = localStorage.getItem('airlock:sound') !== 'false';
notifsEl.onchange = function() { localStorage.setItem('airlock:notifs', notifsEl.checked); };
soundEl.onchange = function() { localStorage.setItem('airlock:sound', soundEl.checked); };

// Version check
(async function checkVersion() {
  try {
    var curRes = await fetch('/version').then(function(r) { return r.json(); });
    var latestRes = await fetch('/version/latest').then(function(r) { return r.json(); });
    var el = document.getElementById('version-info');
    var html = '<div class="current">Version: v' + esc(curRes.version) + '</div>';
    if (latestRes.latest && isNewer(latestRes.latest, curRes.version)) {
      html += '<div class="update-available">New version available: v' + esc(latestRes.latest) + ' &mdash; run <code>npm update -g airlock-bot</code></div>';
    }
    el.innerHTML = html;
  } catch (e) { /* ignore version check failures */ }
})();

function isNewer(latest, current) {
  var a = latest.split('.').map(Number);
  var b = current.split('.').map(Number);
  for (var i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

// Syntax highlight via highlight.js if loaded, otherwise plain escaped text
function highlight(code, lang) {
  if (typeof hljs !== 'undefined') {
    try {
      if (lang) return hljs.highlight(code, { language: lang }).value;
      return hljs.highlightAuto(code).value;
    } catch (e) { /* fall through */ }
  }
  return esc(code);
}

// Render a single arg value — strings get displayed directly (with highlighting
// for multiline content), objects/arrays get JSON-formatted
function renderArgValue(val) {
  if (typeof val === 'string') {
    if (val.includes('\\n') && val.length > 60) {
      return '<div class="arg-val"><pre><code>' + highlight(val) + '</code></pre></div>';
    }
    return '<div class="arg-val">' + esc(val) + '</div>';
  }
  var json = JSON.stringify(val, null, 2);
  return '<div class="arg-val"><pre><code>' + highlight(json, 'json') + '</code></pre></div>';
}

var currentModalCode = null;

function openModal(code) {
  var req = requestData.get(code);
  if (!req) return;
  currentModalCode = code;
  var overlay = document.getElementById('modal-overlay');
  document.getElementById('modal-tool').textContent = req.tool;
  var body = document.getElementById('modal-body');
  var html = '<div class="detail-label">Agent</div><div class="detail-value">' + esc(req.agentId) + '</div>';
  html += '<div class="detail-label">Request Code</div><div class="detail-value mono">' + esc(req.code) + '</div>';
  if (req.timeoutMs) {
    html += '<div class="detail-label">Timeout</div><div class="detail-value">' + Math.round(req.timeoutMs / 1000) + 's</div>';
  }
  html += '<div class="detail-label">Arguments</div><div class="args-full">';
  var keys = Object.keys(req.args || {});
  if (keys.length === 0) {
    html += '<div class="arg-val" style="color:#484f58">No arguments</div>';
  } else {
    for (var i = 0; i < keys.length; i++) {
      html += '<div class="arg-entry"><div class="arg-key">' + esc(keys[i]) + '</div>' + renderArgValue(req.args[keys[i]]) + '</div>';
    }
  }
  html += '</div>';
  body.innerHTML = html;

  var footer = document.getElementById('modal-footer');
  var el = cards.get(code);
  var resolved = el && (el.classList.contains('approved') || el.classList.contains('denied'));
  if (resolved) {
    var which = el.classList.contains('approved') ? 'approved' : 'denied';
    footer.innerHTML = '<div class="status ' + which + '">' + which + '</div>';
  } else {
    footer.innerHTML = '<button class="btn btn-approve" onclick="actAndClose(\\x27approve\\x27,\\x27' + code + '\\x27)">Approve<kbd>A</kbd></button><button class="btn btn-deny" onclick="actAndClose(\\x27deny\\x27,\\x27' + code + '\\x27)">Deny<kbd>D</kbd></button>';
  }
  overlay.classList.add('open');
}

function closeModal(e) {
  if (e && e.target && e.target !== document.getElementById('modal-overlay')) return;
  document.getElementById('modal-overlay').classList.remove('open');
  currentModalCode = null;
}

function actAndClose(action, code) {
  act(action, code);
  document.getElementById('modal-overlay').classList.remove('open');
  currentModalCode = null;
}

function render(req) {
  requestData.set(req.code, req);
  var el = document.createElement('div');
  el.className = 'card';
  el.id = 'card-' + req.code;
  el.onclick = function(e) {
    if (e.target.closest('.actions')) return;
    openModal(req.code);
  };
  var args = JSON.stringify(req.args, null, 2);
  el.innerHTML =
    '<div class="tool">' + esc(req.tool) + '</div>' +
    '<div class="agent">agent: ' + esc(req.agentId) + '</div>' +
    '<div class="args">' + esc(args) + '</div>' +
    '<div class="code">' + req.code + '</div>' +
    '<div class="actions">' +
      '<button class="btn btn-approve" onclick="act(\\x27approve\\x27,\\x27' + req.code + '\\x27)">Approve<kbd>A</kbd></button>' +
      '<button class="btn btn-deny" onclick="act(\\x27deny\\x27,\\x27' + req.code + '\\x27)">Deny<kbd>D</kbd></button>' +
    '</div>';
  cards.set(req.code, el);
  list.prepend(el);
  empty.style.display = 'none';
}

function act(action, code) {
  fetch('/' + action + '?code=' + code, { method: 'POST' });
  var el = cards.get(code);
  if (el) {
    el.querySelector('.actions').innerHTML = '<div class="status ' + action + (action === 'approve' ? 'd' : '') + '">' + action + 'd</div>';
    el.classList.add(action === 'approve' ? 'approved' : 'denied');
  }
}

function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// Only request notification permission if the user has notifications enabled
if ('Notification' in window && notifsEl.checked) Notification.requestPermission();
notifsEl.addEventListener('change', function() {
  if (notifsEl.checked && 'Notification' in window) Notification.requestPermission();
});

// Keyboard shortcuts: a=approve, d=deny, Escape=close modal
function getFirstPendingCode() {
  for (var entry of cards) {
    if (!entry[1].classList.contains('approved') && !entry[1].classList.contains('denied')) return entry[0];
  }
  return null;
}

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') { closeModal(); return; }
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  var key = e.key.toLowerCase();
  if (key === 'a' || key === 'd') {
    var action = key === 'a' ? 'approve' : 'deny';
    var code = currentModalCode || getFirstPendingCode();
    if (!code) return;
    var el = cards.get(code);
    if (el && (el.classList.contains('approved') || el.classList.contains('denied'))) return;
    if (currentModalCode) { actAndClose(action, code); } else { act(action, code); }
  }
});

var es = new EventSource('/events');
es.onmessage = function(e) {
  var msg = JSON.parse(e.data);
  if (msg.type === 'new') {
    render(msg.request);
    if (notifsEl.checked && Notification.permission === 'granted') {
      new Notification('Airlock: ' + msg.request.tool, {
        body: 'agent: ' + msg.request.agentId + '\\n' + msg.request.code,
        tag: msg.request.code,
        silent: !soundEl.checked,
      });
    }
  }
  if (msg.type === 'resolved') {
    var el = cards.get(msg.code);
    if (el) {
      el.querySelector('.actions').innerHTML = '<div class="status ' + (msg.action === 'approved' ? 'approved' : 'denied') + '">' + msg.action + '</div>';
      el.classList.add(msg.action);
    }
  }
};
</scr` +
  `ipt>
</body>
</html>`;
