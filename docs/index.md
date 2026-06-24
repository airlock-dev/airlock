# Airlock

Airlock is a permissions-aware MCP gateway for AI agents.

It sits between agents like Claude Code, Cursor, and OpenClaw and the tools they want to use. Airlock decides which tools are visible, which calls are auto-allowed, which require human approval, and which are denied entirely.

## Why it exists

- AI coding agents are useful, but raw tool access is too broad.
- Static MCP manifests do not capture per-agent policy well.
- Human approval is valuable, but approval fatigue is real.
- You need an audit trail for what ran, by whom, and under what policy.
- Untrusted content (web pages, tool outputs, files) can instruct agents to take unauthorized actions.

## What Airlock can front

- MCP servers over stdio, SSE, and streamable HTTP
- Built-in shell execution through `exec/run`
- Built-in HTTP tools like `http/get`, `http/post`
- Sandboxed script variants built from `exec/run` aliases and sandbox presets
- CLI tools exposed as named MCP tools (auto-discovered from `--help`, Fig specs, or shell completions)
- REST APIs exposed as MCP tools (auto-discovered from OpenAPI specs)
- External clients through the `/hook` endpoint

## Key features

- **Per-agent allowlists** with glob patterns and tool hiding
- **Human-in-the-loop approval** via Telegram, Slack, dashboard, macOS, TUI, webhook, or OpenClaw
- **Composable profiles** with inheritance via `extends`
- **Sandbox presets and tool variants** — same tool, different security envelope
- **Middleware pipeline** — injection detection, canary tokens, PII classification, output scanning, rate limiting, schema validation
- **Auto-discovery** for CLI tools and OpenAPI specs
- **Full audit trail** to SQLite with secret redaction
- **Management API** for querying logs and managing approvals programmatically
- **Hot reload** — edit config without restarting
- **Batched notifications** to reduce approval fatigue
- **OS-level sandboxing** through the sandbox runtime
- **Native macOS companion app** for menu bar approvals

## Start here

- New to Airlock: [Quickstart](/quickstart)
- Deploying Airlock: [Docker Deploy](/guides/docker-deploy)
- Connecting Claude Code: [Claude Code Setup](/guides/claude-code)
- Understanding policy: [Permissions](/concepts/permissions)
- Building safer fast paths: [Sandbox Presets and Variants](/concepts/sandboxing)
- Auto-generating configs: [CLI Discovery](/guides/cli-discovery) and [API Discovery](/guides/api-discovery)
- Security middleware: [Middleware Pipeline](/concepts/middleware)
- Approval providers: [HITL Providers](/reference/hitl-providers) and [Dashboard](/guides/dashboard)
- Full config reference: [Config Reference](/reference/config)
