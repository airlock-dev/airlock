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

- MCP servers over stdio, SSE, and streamable HTTP (including browser OAuth2, machine-to-machine `client_credentials`, and hot-added HTTP providers with file-backed bearer tokens)
- MCP Events (SEP-3415, `io.modelcontextprotocol/events`) with default-deny poll and push subscriptions
- Built-in shell execution through `exec/run`
- Built-in HTTP tools like `http/get`, `http/post` (with optional staged file uploads)
- Sandboxed script variants built from `exec/run` aliases and sandbox presets
- CLI tools exposed as named MCP tools (auto-discovered from `--help`, Fig specs, or shell completions)
- REST APIs exposed as MCP tools (auto-discovered from OpenAPI specs, including `multipart/form-data` and binary uploads)
- External clients through the optional control-plane `/hook` endpoint

## Key features

- **Per-agent policy** with `allow`, `ask`, `deny`, `remember_allow`, glob patterns, tool hiding, `arg_policy` / `arg_scope` (`value_sets` + `arg_dimensions`), and `command_policy` for CLI-dispatcher tools
- **Human-in-the-loop approval** via Telegram, Command Center dashboard, macOS dialog & Companion, iOS Companion app (APNs push, interactive actions, TestFlight, cross-device dismissal), TUI, stdio, or OpenClaw, with Slack and generic webhook notifications for custom decision flows
- **Grants, plans, async approvals, and previews** — time-limited grants (`tool`, `tier`, `provider`, `profile`), multi-step plans (`airlock_request_approval`), non-blocking async mode (`airlock_await_approval`), batched notifications, and operator-only structured approval previews (`approvals.previews`)
- **Rebuilt Command Center** — Approvals Inbox, active Grants management, Activity audit log, Agent Composer with one-time `token_sha256` keys, Policy Assistant, and Provider Health
- **Composable profiles** with inheritance via `extends` and top-level `default_profile`
- **Sandbox presets and tool variants** — same tool, different security envelope, backed by OS-level sandboxing
- **Middleware pipeline** — schema validation, staged `upload-policy`, injection detection, canary tokens, PII classification, output scanning, rate limiting, and output size limiting / summarization
- **Stateless Streamable HTTP (MCP 2026-07-28)** — sessionless `/agents/:agentId/mcp` with optional `X-Airlock-Session-Id` scoping alongside legacy SSE and lean stdio mode
- **MCP Events (SEP-3415) & MCP Apps** — default-deny `events/poll` and `events/stream` subscriptions with `events.arg_policy`, prompt-injection inspection, and immediate stream revocation on config reload, plus opt-in `mcp_apps: true` inline view proxying (`io.modelcontextprotocol/ui`) with namespaced `ui://` URIs and audited `resources/read`
- **Staged File Uploads (`uploads.enabled: true`)** — stage binary and large files from disk with single-use URLs and deliver them across OpenAPI, built-in HTTP, upstream MCP, and CLI backends without passing raw bytes through LLM context
- **Resilient OAuth, `client_credentials` & hot-add HTTP providers** — browser OAuth2 (including native gateway `/oauth/callback` via `oauth_callback_mode: gateway`, single-writer revisioned grant storage with history/restore via `airlock oauth`, and persisted discovery), machine-to-machine `client_credentials`, and zero-downtime hot-add HTTP providers with `bearer_token_file`
- **Credential Health & Catalog Drift** — active `credential_probe` verification alongside SHA-256 `toolCatalog` and `eventCatalog` contract fingerprints on `/health`
- **Auto-discovery** for CLI tools and OpenAPI specs
- **Policy introspection CLI** — `config check`, `explain`, `who-can`, `tools`, and `lint`
- **Full audit trail** to SQLite with secret redaction, split **Management API**, and config **hot reload**
- **Native macOS and iOS companion apps** — menu bar approvals on macOS and APNs push approvals on iOS with interactive actions and cross-device dismissal

## Start here

- New to Airlock: [Quickstart](/quickstart)
- Deploying Airlock: [Docker Deploy](/guides/docker-deploy)
- Connecting Claude Code: [Claude Code Setup](/guides/claude-code)
- Connecting network MCP clients: [Connecting HTTP Agents](/guides/http-agents)
- Understanding policy: [Permissions](/concepts/permissions)
- Building safer fast paths: [Sandbox Presets and Variants](/concepts/sandboxing)
- Staging binary & large files: [File Uploads](/guides/file-uploads)
- Auto-generating configs: [CLI Discovery](/guides/cli-discovery) and [API Discovery](/guides/api-discovery)
- Security middleware: [Middleware Pipeline](/concepts/middleware)
- Approval providers: [HITL Providers](/reference/hitl-providers) and [Dashboard](/guides/dashboard)
- Full config reference: [Config Reference](/reference/config)
