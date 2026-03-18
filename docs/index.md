# Airlock

Airlock is a permissions-aware MCP gateway for AI agents.

It sits between agents like Claude Code, Cursor, and OpenClaw and the tools they want to use. Airlock decides which tools are visible, which calls are auto-allowed, which require human approval, and which are denied entirely.

## Why it exists

- AI coding agents are useful, but raw tool access is too broad.
- Static MCP manifests do not capture per-agent policy well.
- Human approval is valuable, but approval fatigue is real.
- You need an audit trail for what ran, by whom, and under what policy.

## What Airlock can front

- MCP servers over stdio, SSE, and streamable HTTP
- built-in shell execution through `exec/run`
- built-in HTTP tools like `http/get`
- CLI tools exposed as named MCP tools
- OpenAPI specs exposed as MCP tools
- external clients through the `/hook` endpoint

## Recent features

- sandbox presets and alias-based tool variants
- real macOS sandbox smoke tests for filesystem and network behavior
- `/hook` support for external approval and policy checks
- a completion-driven CLI discovery/configuration flow

## Start here

- New to Airlock: [Quickstart](/quickstart)
- Connecting Claude Code: [Claude Code Setup](/guides/claude-code)
- Choosing the right local approval flow: [Local Approval UX](/guides/local-approvals)
- Understanding policy: [Permissions](/concepts/permissions)
- Building safer fast paths: [Sandbox Presets and Variants](/concepts/sandboxing)
