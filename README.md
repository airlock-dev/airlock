# Airlock

[![CI](https://github.com/airlock-dev/airlock/actions/workflows/ci.yml/badge.svg)](https://github.com/airlock-dev/airlock/actions/workflows/ci.yml)
[![Node](https://img.shields.io/node/v/airlock-bot)](https://www.npmjs.com/package/airlock-bot)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A permissions-aware MCP gateway that sits between AI agents (Claude Code, Cursor, OpenClaw, etc.) and your downstream tool servers. Airlock enforces per-agent allowlists, requires human approval for sensitive operations, and keeps a full audit trail of every tool call.

```
Agent (Claude Code / Cursor / OpenClaw)
  │  stdio or SSE
  ▼
Airlock  ←→  HITL (Telegram / Slack / webhook / stdio)
  │
  ├── github MCP server
  ├── filesystem MCP server
  ├── built-in: http/get, http/post, ...
  └── built-in: exec/run
```

## Features

- **Per-agent allowlists** — each profile sees only the tools it's allowed to call, presented with namespaced names (`github/create_pr`, `filesystem/read_file`)
- **HITL approval** — flag sensitive tools as requiring human sign-off; the agent blocks until you approve or deny
- **Batched notifications** — requests arriving within a time window are bundled into a single message
- **Multiple HITL providers** — Telegram, Slack webhook, generic webhook, OpenClaw, or stdio (for dev)
- **Built-in tools** — `http/*` (get/post/put/patch/delete/head) and `exec/run` with their own policy engines
- **Security defaults** — localhost and RFC-1918 ranges blocked for HTTP tools; per-agent domain allowlists
- **Audit log** — every tool call logged to SQLite with agent, tool, args, result, duration, and HITL outcome
- **Hot reload** — edit `gateway.yaml` and allowlist/HITL config updates without restarting
- **Leaner stdio mode** — `--profile` flag runs with no HTTP server and only connects to MCPs the profile actually uses

## Install

```bash
npm install -g airlock-bot
```

## Quick start

```bash
# 1. Copy and edit the example config
cp node_modules/airlock-bot/examples/gateway.yaml ./airlock.yaml

# 2. Run in stdio mode for a single agent (e.g. from Claude Code)
airlock --profile claude-code --config airlock.yaml

# 3. Or run as a full gateway server (SSE on port 4111)
airlock --config airlock.yaml
```

## Claude Code setup

Add Airlock as an MCP server in `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "airlock": {
      "command": "airlock",
      "args": ["--profile", "claude-code", "--config", "/path/to/airlock.yaml"]
    }
  }
}
```

Or without a global install:

```json
{
  "mcpServers": {
    "airlock": {
      "command": "npx",
      "args": ["airlock-bot", "--profile", "claude-code", "--config", "/path/to/airlock.yaml"]
    }
  }
}
```

See [`examples/claude-code-setup.md`](examples/claude-code-setup.md) for a full walkthrough.

## Config

```yaml
mcps:
  github:
    type: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}"

agents:
  helena:
    allow:
      - github/*
      - filesystem/*
      - http/get
      - exec/run
    hitl:
      - github/create_pr
      - github/merge_pull_request
      - exec/run
    exec:
      allow: ["git status", "git diff*", "npm test*"]
      hitl:  ["git push*"]
      deny:  ["sudo *", "rm -rf *"]
      env:
        PATH: "/usr/local/bin:/usr/bin:/bin"
    http:
      domain_allowlist: ["api.github.com", "*.sentry.io"]

hitl:
  provider:
    type: telegram
    bot_token: "${TELEGRAM_BOT_TOKEN}"
    chat_id: "${TELEGRAM_CHAT_ID}"
  timeout_ms: 300000
  batch_window_ms: 10000
```

See [`examples/gateway.yaml`](examples/gateway.yaml) for a fully annotated reference config.

## HITL providers

| Provider | Config `type` | Notes |
|----------|--------------|-------|
| macOS dialog | `macos` | Native approve/deny popup via `osascript` — best for local dev on Mac |
| Dashboard | `dashboard` | Localhost web UI (default port 4112) with live SSE updates |
| Telegram bot | `telegram` | Long-polls for replies; reply `approve ABC123` or `deny ABC123` |
| Slack webhook | `slack` | Incoming webhook, fire-and-forget; pair with slash commands for approvals |
| Generic webhook | `webhook` | POSTs `{requests, text}` JSON; configurable headers |
| OpenClaw | `openclaw` | WebSocket RPC to OpenClaw gateway; see [`examples/openclaw-setup.md`](examples/openclaw-setup.md) |
| stdio | `stdio` | Prints to stderr, reads from stdin — for local dev and testing |

## API

When running in gateway mode, Airlock exposes a management API:

```
GET  /health                   — MCP health, pending HITL count, uptime
GET  /hitl/pending             — list pending approval requests
POST /hitl/approve/:id         — approve a request
POST /hitl/deny/:id            — deny a request (body: {"reason": "..."})
GET  /audit?agent=&tool=&since=&limit=  — query audit log
```

All management endpoints require `Authorization: Bearer <api_secret>` when `server.api_secret` is set.

## Testing

```bash
npm test                              # 223 unit + integration tests
npm test -- test/integration.test.ts  # just the integration test (real child process)
npm run build                         # TypeScript compile check
```

### Interactive testing with MCP Inspector

A self-contained test config with an echo MCP server is included — no tokens or external services needed:

```bash
npx @modelcontextprotocol/inspector npx tsx src/index.ts -- --profile test --config test/test-gateway.yaml
```

Open `http://localhost:6274`, then list tools and call `tools/echo` or `tools/add` through the UI.

## systemd

```bash
sudo cp airlock.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now airlock
```

See [`airlock.service`](airlock.service) for the full unit file.

## License

[MIT](LICENSE) © 2026 Airlock
