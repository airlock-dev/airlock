# Airlock

[![CI](https://github.com/airlock-dev/airlock/actions/workflows/ci.yml/badge.svg)](https://github.com/airlock-dev/airlock/actions/workflows/ci.yml)
[![Node](https://img.shields.io/node/v/airlock-bot)](https://www.npmjs.com/package/airlock-bot)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**[airlock.bot](https://airlock.bot)** · **[Documentation](https://docs.airlock.bot)**

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

Add Airlock as an MCP server in `~/.claude/mcp.json`:

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
    max_output_bytes: 30000 # default matches Claude Code's limit
    commands:
      # Inline commands override discovered ones with the same name
      custom-deploy:
        exec: 'git push origin main'
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
    args: ['-y', '@modelcontextprotocol/server-github']
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN}'

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
        exec: 'git log --oneline -n {count}'
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
      allow: ['git status', 'git diff*', 'npm test*']
      ask: ['git push*']
      deny: ['sudo *', 'rm -rf *']
      env:
        PATH: '/usr/local/bin:/usr/bin:/bin'
    http:
      domain_allowlist: ['api.github.com', '*.sentry.io']

  claude-code:
    extends: [readonly]
    exec:
      allow: ['git status', 'git diff*', 'npm test']
      deny: ['*']

approvals:
  provider:
    type: telegram
    bot_token: '${TELEGRAM_BOT_TOKEN}'
    chat_id: '${TELEGRAM_CHAT_ID}'
  timeout_ms: 300000
  batch_window_ms: 10000
```

Precedence: **deny > ask > allow > default-deny**

See [`examples/gateway.yaml`](examples/gateway.yaml) for a fully annotated reference config and [`examples/profiles.yaml`](examples/profiles.yaml) for composable profile examples.

## Sandbox presets and tool variants

Airlock can expose multiple names for the same underlying tool by using `tool_overrides.<name>.alias_of`.
This is especially useful when you want different approval posture for the same capability:

- a tightly sandboxed variant that is safe enough to `allow`
- a broader variant that still goes through `ask`

That pattern helps reduce approval fatigue without giving up higher-power versions of the tool.

### Why use presets?

Sandbox config gets repetitive quickly. A typical local-only transform tool wants the same shape every time:

- read the repo
- write only to `/tmp`
- deny secret directories like `~/.ssh`
- no outbound network

Top-level `sandbox_presets` let you define that once and reuse it across agents and tool variants.

### Example: safe Python fast path + approved full Python

```yaml
providers:
  exec: builtin

sandbox_presets:
  local_transform:
    filesystem:
      allow_read:
        - '.'
      allow_write:
        - '/tmp'
        - '/private/tmp'
      deny_read:
        - '~/.ssh'
        - '~/.aws'
        - '.env'
      deny_write:
        - '.'
    network:
      allowed_domains: []
      denied_domains: []

  github_only:
    network:
      allowed_domains:
        - 'github.com'
        - '*.github.com'
        - 'api.github.com'
      denied_domains: []

agents:
  claude-code:
    allow:
      - 'python/sandboxed'
    ask:
      - 'python/full'
      - 'python/github'

    sandbox:
      enabled: true
      presets:
        - local_transform

    tool_overrides:
      python/sandboxed:
        alias_of: 'exec/run'
        description: 'Run Python for local transformations only'

      python/full:
        alias_of: 'exec/run'
        description: 'Run Python with broader permissions after approval'
        sandbox:
          filesystem:
            allow_write:
              - '.'
              - '/tmp'
              - '/private/tmp'
            deny_write: []
          network:
            allowed_domains:
              - 'pypi.org'
              - '*.pythonhosted.org'
            denied_domains: []

      python/github:
        alias_of: 'exec/run'
        description: 'Run Python with GitHub-only network access after approval'
        sandbox_presets:
          - github_only
```

In this example:

- `python/sandboxed` inherits the agent's `local_transform` preset and can be broadly allowed
- `python/full` keeps the same base tool but overrides filesystem and network to be more permissive, so it should stay in `ask`
- `python/github` reuses the same local transform defaults but adds a reusable GitHub-only network preset

### Preset merge rules

Presets are expanded during config parsing.

- `sandbox.presets` applies to the whole agent sandbox baseline
- `tool_overrides.<tool>.sandbox_presets` applies only to that tool variant
- explicit `sandbox` values on the tool override win over preset values when they conflict
- deny lists are additive
- allow lists usually replace the previous value so the tool variant can define a tighter or broader envelope intentionally

### Approval and audit visibility

When a tool call requires approval, Airlock includes the resolved sandbox summary in the approval payload and formatter output.
That means operators can see things like:

- which presets were applied
- whether network is disabled or limited to specific domains
- where writes are allowed
- which paths are explicitly denied

Audit entries also include the resolved sandbox context alongside the tool arguments, so you can later verify not just what command ran, but under what safety envelope it ran.

### Practical guidance

- Use a sandboxed `allow` variant for cheap local work like JSON transforms, parsing, codegen, or text munging
- Keep networked or repo-writing variants in `ask` until you've smoke-tested the exact runtime you care about
- Prefer a small number of named presets such as `local_transform`, `github_only`, `npm_registry`, or `readonly_repo`
- If a tool needs a one-off tweak, put that in the tool override instead of copying a giant sandbox block everywhere

See [`examples/sandbox-presets.yaml`](examples/sandbox-presets.yaml) for a fuller example config focused on this pattern.

## HITL providers

| Provider        | Config `type` | Notes                                                                                             |
| --------------- | ------------- | ------------------------------------------------------------------------------------------------- |
| TUI             | `tui`         | Terminal UI on stderr — `[a]pprove` / `[d]eny` with `j/k` navigation via `/dev/tty`               |
| macOS dialog    | `macos`       | Native approve/deny popup via `osascript` — best for local dev on Mac                             |
| Dashboard       | `dashboard`   | Browser UI with live SSE updates; runs in-process or as a standalone admin dashboard              |
| Telegram bot    | `telegram`    | Long-polls for replies; reply `approve ABC123` or `deny ABC123`                                   |
| Slack webhook   | `slack`       | Incoming webhook, fire-and-forget; pair with slash commands for approvals                         |
| Generic webhook | `webhook`     | POSTs `{requests, text}` JSON; configurable headers                                               |
| OpenClaw        | `openclaw`    | WebSocket RPC to OpenClaw gateway; see [`examples/openclaw-setup.md`](examples/openclaw-setup.md) |
| stdio           | `stdio`       | Prints to stderr, reads from stdin — for local dev and testing                                    |

## API

When running in gateway mode, Airlock can expose a separate management API
listener for operator/control-plane routes. It is disabled by default and binds
to `127.0.0.1:4113` when enabled:

```yaml
server:
  api_secret: ${AIRLOCK_API_SECRET}
  management_api:
    enabled: true
```

```
GET  /health                   — MCP health, pending HITL count, uptime
GET  /hitl/pending             — list pending approval requests
POST /hitl/approve/:id         — approve a request
POST /hitl/deny/:id            — deny a request (body: {"reason": "..."})
GET  /audit?agent=&tool=&since=&limit=  — query audit log
GET  /events                   — dashboard approval event stream
POST /approve?code=ABC123      — approve a request by approval code
POST /deny?code=ABC123         — deny a request by approval code
GET  /admin/tools              — dashboard tool catalog
```

All management endpoints require `Authorization: Bearer <api_secret>`.
The management listener must use a different port than the agent MCP
data-plane listener (`server.port`, default `4111`). Binding the management API
beyond loopback requires the explicit `management_api.insecure_remote_bind: true`
opt-in and trusted network controls.

## Testing

```bash
npm test                              # unit + integration tests
npm test -- test/integration.test.ts  # just the integration test (real child process)
npm run typecheck                     # TypeScript type check (no emit)
npm run build                         # Full build to dist/
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

## Docker

Airlock can also run as a containerized gateway:

```bash
docker build -t airlock-bot .
mkdir -p airlock-config
cp examples/docker-gateway.yaml airlock-config/airlock.yaml
docker run --rm \
  --env-file .env \
  -v "$PWD/airlock-config:/config" \
  -v airlock-data:/data \
  -p 127.0.0.1:4111:4111 \
  -p 127.0.0.1:4113:4113 \
  -p 127.0.0.1:4112:4112 \
  airlock-bot
```

The dashboard edits `/config/airlock.yaml` and writes `/config/airlock.bak`, so
mount a config directory when dashboard editing is enabled.

See [`examples/docker-compose.yaml`](examples/docker-compose.yaml) and
[`docs/guides/docker-deploy.md`](docs/guides/docker-deploy.md) for a VPS or
reverse-proxy deployment. The compose example uses split mode: the gateway mounts
config read-only, while the dashboard mounts the same config directory read-write
for admin edits and approval decisions.

## License

[MIT](LICENSE) © 2026 Airlock
