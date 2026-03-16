#!/usr/bin/env node
/**
 * Mock dashboard server for testing the macOS companion app.
 * Simulates Airlock's dashboard provider SSE + HTTP API on port 4112.
 *
 * Usage:
 *   node mock-dashboard.mjs
 *
 * Then press Enter in the terminal to send a fake approval request.
 * The companion app should pick it up via SSE.
 */

import { createServer } from "http";
import { randomUUID } from "crypto";
import { createInterface } from "readline";

const PORT = 4112;
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

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\nMock Airlock dashboard running on http://127.0.0.1:${PORT}`);
  console.log(`\nCommands:`);
  console.log(`  [Enter]     → send a random approval request`);
  console.log(`  "burst"     → send 3 requests at once`);
  console.log(`  "timeout"   → send a request with 10s timeout`);
  console.log(`  "q" / Ctrl-C → quit\n`);
});

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
