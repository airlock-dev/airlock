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
 */

import { createServer } from "http";
import { randomUUID } from "crypto";
import { createInterface } from "readline";

const PORT = Number(process.env.PORT ?? 4113);
const REQUIRED_TOKEN = process.env.AIRLOCK_API_SECRET ?? "";
const clients = new Set();
const pending = new Map();
let codeCounter = 0;

const TOOLS = [
  "fs_read_file",
  "shell_exec",
  "git_push",
  "db_query",
  "send_email",
  "deploy_production",
];
const AGENTS = ["claude-agent", "coder-bot", "deploy-agent", "data-pipeline"];

function randomCode() {
  codeCounter++;
  const words = ["ALPHA", "BRAVO", "DELTA", "ECHO", "FOXTROT", "GOLF"];
  const w1 = words[Math.floor(Math.random() * words.length)];
  const w2 = words[Math.floor(Math.random() * words.length)];
  return `${w1}-${w2}-${codeCounter}`;
}

function randomRequest() {
  const tool = TOOLS[Math.floor(Math.random() * TOOLS.length)];
  const agent = AGENTS[Math.floor(Math.random() * AGENTS.length)];
  return {
    id: randomUUID(),
    code: randomCode(),
    agentId: agent,
    tool,
    args: {
      path: "/Users/dev/project/src/index.ts",
      command: tool === "shell_exec" ? "rm -rf /tmp/build && npm run build" : undefined,
      query: tool === "db_query" ? "SELECT * FROM users WHERE active = true" : undefined,
      content: tool === "fs_read_file" ? "Reading sensitive configuration file" : undefined,
    },
    timeoutMs: 30000,
  };
}

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.write(msg);
    } catch {}
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (REQUIRED_TOKEN) {
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${REQUIRED_TOKEN}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
  }

  // POST /inject with JSON body → broadcast a custom request
  if (req.method === "POST" && url.pathname === "/inject") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const request = JSON.parse(body);
        request.id = request.id ?? randomUUID();
        request.code = request.code ?? randomCode();
        request.timeoutMs = request.timeoutMs ?? 60000;
        pending.set(request.code, request);
        broadcast({ type: "new", request });
        console.log(`  📨 Injected: ${request.tool} [${request.code}]`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: request.code }));
      } catch (e) {
        res.writeHead(400);
        res.end("bad json");
      }
    });
    return;
  }

  // POST /inject-activity with JSON body -> broadcast a custom activity event
  if (req.method === "POST" && url.pathname === "/inject-activity") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const event = JSON.parse(body);
        event.id = event.id ?? randomUUID();
        event.kind = event.kind ?? "notification";
        event.agentId = event.agentId ?? "mock-agent";
        event.title = event.title ?? (event.kind === "log" ? "Mock log" : "Mock notification");
        event.body = event.body ?? "";
        event.severity = event.severity ?? "info";
        event.createdAt = event.createdAt ?? new Date().toISOString();
        broadcast({ type: "activity", event });
        console.log(`  📝 Activity: ${event.kind} ${event.title}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: event.id }));
      } catch (e) {
        res.writeHead(400);
        res.end("bad json");
      }
    });
    return;
  }

  if (url.pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    clients.add(res);
    // Replay pending
    for (const r of pending.values()) {
      res.write(`data: ${JSON.stringify({ type: "new", request: r })}\n\n`);
    }
    req.on("close", () => clients.delete(res));
    console.log(`  [sse] client connected (${clients.size} total)`);
    return;
  }

  if (req.method === "POST" && url.pathname === "/approve") {
    const code = url.searchParams.get("code");
    if (code && pending.has(code)) {
      pending.delete(code);
      broadcast({ type: "resolved", code, action: "approved" });
      console.log(`  ✅ Approved: ${code}`);
    }
    res.writeHead(200);
    res.end("ok");
    return;
  }

  if (req.method === "POST" && url.pathname === "/deny") {
    const code = url.searchParams.get("code");
    if (code && pending.has(code)) {
      pending.delete(code);
      broadcast({ type: "resolved", code, action: "denied" });
      console.log(`  ❌ Denied: ${code}`);
    }
    res.writeHead(200);
    res.end("ok");
    return;
  }

  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", pending: pending.size }));
    return;
  }

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", pendingApprovals: pending.size }));
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\nMock Airlock dashboard running on http://127.0.0.1:${PORT}`);
  if (REQUIRED_TOKEN) {
    console.log("  bearer auth enabled; use AIRLOCK_API_SECRET as the companion token");
  }
  console.log(`\nCommands:`);
  console.log(`  [Enter]     → send a random approval request`);
  console.log(`  "burst"     → send 3 requests at once`);
  console.log(`  "timeout"   → send a request with 10s timeout`);
  console.log(`  "q" / Ctrl-C → quit\n`);
});

// In non-TTY mode (e.g. nohup), skip readline — use POST /inject instead
if (!process.stdin.isTTY) {
  console.log("  (non-interactive mode: use POST /inject to send requests)\n");
} else {

const rl = createInterface({ input: process.stdin, output: process.stdout });

rl.on("line", (input) => {
  const cmd = input.trim().toLowerCase();

  if (cmd === "q" || cmd === "quit") {
    console.log("Shutting down...");
    server.close();
    process.exit(0);
  }

  if (cmd === "burst") {
    for (let i = 0; i < 3; i++) {
      const req = randomRequest();
      pending.set(req.code, req);
      broadcast({ type: "new", request: req });
      console.log(`  📨 Sent: ${req.tool} [${req.code}]`);
    }
    return;
  }

  if (cmd === "timeout") {
    const req = randomRequest();
    req.timeoutMs = 10000;
    pending.set(req.code, req);
    broadcast({ type: "new", request: req });
    console.log(`  📨 Sent (10s timeout): ${req.tool} [${req.code}]`);
    return;
  }

  // Default: send one request
  const req = randomRequest();
  pending.set(req.code, req);
  broadcast({ type: "new", request: req });
  console.log(`  📨 Sent: ${req.tool} [${req.code}]`);
});

} // end TTY-only block
