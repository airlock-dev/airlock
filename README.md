# Airlock

[![CI](https://github.com/airlock-dev/airlock/actions/workflows/ci.yml/badge.svg)](https://github.com/airlock-dev/airlock/actions/workflows/ci.yml)
[![Node](https://img.shields.io/node/v/airlock-bot)](https://www.npmjs.com/package/airlock-bot)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A permissions-aware MCP gateway that sits between AI agents (Claude Code, Cursor, OpenClaw, etc.) and your downstream tool servers, CLI tools, and REST APIs. Airlock enforces per-agent allowlists, requires human approval for sensitive operations, and keeps a full audit trail of every tool call.

```
Agent (Claude Code / Cursor / OpenClaw)
  │  stdio or SSE
  ▼
Airlock  ←→  HITL (Telegram / Slack / webhook / TUI / macOS / dashboard)
  │
  ├── MCP servers (github, filesystem, ...)
  ├── CLI tools (git, docker, kubectl, ...)
  ├── REST APIs (any OpenAPI spec)
  ├── built-in: http/get, http/post, ...
  └── built-in: exec/run
```

## Features

- **Per-agent allowlists** — each agent sees only the tools it's allowed to call, presented with namespaced names (`github/create_pr`, `filesystem/read_file`)
- **HITL approval** — flag sensitive tools as requiring human sign-off; the agent blocks until you approve or deny
- **Composable profiles** — define reusable permission sets (`readonly`, `developer`) that agents inherit via `extends`
- **Backend adapters** — unified interface for MCP servers, CLI tools, REST APIs, HTTP, and exec
- **CLI tool discovery** — auto-generate config from `--help` output or [Fig autocomplete specs](https://github.com/withfig/autocomplete)
- **API discovery** — auto-generate config from OpenAPI 3.x specs
- **Configure agent TUI** — interactive terminal UI to assign allow/ask/deny per tool
- **Batched notifications** — requests arriving within a time window are bundled into a single message
- **Multiple HITL providers** — Telegram, Slack webhook, generic webhook, OpenClaw, TUI, macOS dialog, dashboard, or stdio
- **Security defaults** — localhost and RFC-1918 ranges blocked for HTTP tools; per-agent domain allowlists; shell injection prevention
- **Audit log** — every tool call logged to SQLite with agent, tool, args, result, duration, and HITL outcome
- **Hot reload** — edit config and allowlist/HITL config updates without restarting
- **Leaner stdio mode** — `--agent` flag runs with no HTTP server and only connects to MCPs the agent actually uses

## Install

```bash
npm install -g airlock-bot
```

## Quick start

```bash
# 1. Discover tools from a CLI you want to expose
airlock discover cli git --output git-commands.yaml

# 2. Create your config referencing the discovered commands
cat > airlock.yaml <<'EOF'
providers:
  github:
    type: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}"
  exec: builtin
  http: builtin

clis:
  git:
    discovered: ./git-commands.yaml
    commands:
      # Inline overrides take precedence over discovered commands
      status:
        exec: git status
        params: {}

agents:
  claude-code:
    allow:
      - github/*
      - git/*
    ask:
      - git/push
    deny:
      - exec/run
EOF

# 3. Run in stdio mode for a single agent (e.g. from Claude Code)
airlock --agent claude-code --config airlock.yaml

# 4. Or run as a full gateway server (SSE on port 4111)
airlock --config airlock.yaml
```

## Claude Code setup

Add Airlock as an MCP server in `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "airlock": {
      "command": "airlock",
      "args": ["--agent", "claude-code", "--config", "/path/to/airlock.yaml"]
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
      "args": ["airlock-bot", "--agent", "claude-code", "--config", "/path/to/airlock.yaml"]
    }
  }
}
```

See [`examples/claude-code-setup.md`](examples/claude-code-setup.md) for a full walkthrough.

## Discovery

Auto-generate Airlock config from existing tools instead of writing YAML by hand.

### CLI discovery

```bash
# Parse --help output (works with any CLI)
airlock discover cli docker

# Try Fig autocomplete specs first, fall back to --help
airlock discover cli kubectl --fig

# Write to a file, limit recursion depth
airlock discover cli git --output git-commands.yaml --max-depth 2

# Only include specific commands
airlock discover cli npm --include install,test,run
```

Reference the output in your config:

```yaml
clis:
  git:
    discovered: ./git-commands.yaml
    max_output_bytes: 30000   # default matches Claude Code's limit
    commands:
      # Inline commands override discovered ones with the same name
      custom-deploy:
        exec: "git push origin main"
        params: {}
```

### API discovery

```bash
# From a local spec file
airlock discover api ./petstore.json --output petstore-api.yaml

# From a URL
airlock discover api https://api.example.com/openapi.json --base-url https://api.example.com

# Filter endpoints
airlock discover api ./spec.json --include "GET *" --exclude "DELETE *"
```

Reference in config:

```yaml
apis:
  petstore:
    spec: ./petstore.json
    base_url: https://petstore.example.com/v1
    auth:
      type: bearer
      token: ${PETSTORE_TOKEN}
    timeout_ms: 30000
    max_response_bytes: 1048576
```

### Configure agent TUI

Interactively assign allow/ask/deny to tools discovered from your live MCP servers:

```bash
npm run configure-agent -- --config ./airlock.yaml --agent claude-code
```

Navigate with `j/k`, set permissions with `a`/`s`/`d` (per tool or bulk per provider), then `Enter` to edit config directly, copy to clipboard, or print YAML.

## Config

```yaml
providers:
  github:
    type: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}"

  exec: builtin
  http: builtin

# CLI tools exposed as MCP tools
clis:
  git:
    discovered: ./git-commands.yaml
    shell: /bin/bash
    max_output_bytes: 30000
    commands:
      status:
        exec: git status
        params: {}
      log:
        exec: "git log --oneline -n {count}"
        params:
          count:
            type: number
            required: false
            default: 10

# REST APIs exposed as MCP tools
apis:
  petstore:
    spec: ./petstore.json
    base_url: https://petstore.example.com/v1
    auth:
      type: bearer
      token: ${PETSTORE_TOKEN}

# Reusable permission profiles
profiles:
  readonly:
    allow:
      - github/list*
      - github/get*
      - http/get

  developer:
    allow:
      - github/*
      - git/*
      - exec/run
    ask:
      - github/create_pr
      - github/merge_pull_request

agents:
  helena:
    extends: [readonly, developer]
    exec:
      allow: ["git status", "git diff*", "npm test*"]
      ask:   ["git push*"]
      deny:  ["sudo *", "rm -rf *"]
      env:
        PATH: "/usr/local/bin:/usr/bin:/bin"
    http:
      domain_allowlist: ["api.github.com", "*.sentry.io"]

  claude-code:
    extends: [readonly]
    exec:
      allow: ["git status", "git diff*", "npm test"]
      deny: ["*"]

approvals:
  provider:
    type: telegram
    bot_token: "${TELEGRAM_BOT_TOKEN}"
    chat_id: "${TELEGRAM_CHAT_ID}"
  timeout_ms: 300000
  batch_window_ms: 10000
```

Precedence: **deny > ask > allow > default-deny**

See [`examples/gateway.yaml`](examples/gateway.yaml) for a fully annotated reference config and [`examples/profiles.yaml`](examples/profiles.yaml) for composable profile examples.

## HITL providers

| Provider | Config `type` | Notes |
|----------|--------------|-------|
| TUI | `tui` | Terminal UI on stderr — `[a]pprove` / `[d]eny` with `j/k` navigation via `/dev/tty` |
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
npm test                              # unit + integration tests
npm test -- test/integration.test.ts  # just the integration test (real child process)
npm run build                         # TypeScript compile check
```

### Interactive testing with MCP Inspector

A self-contained test config with an echo MCP server is included — no tokens or external services needed:

```bash
npx @modelcontextprotocol/inspector npx tsx src/index.ts -- --agent test --config test/test-gateway.yaml
```

Open `http://localhost:6274`, then list tools and call `echo/echo` or `echo/add` through the UI.

## systemd

```bash
sudo cp airlock.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now airlock
```

See [`airlock.service`](airlock.service) for the full unit file.

## License

[MIT](LICENSE) © 2026 Airlock
