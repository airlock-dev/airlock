---
name: airlock
description: Configure, validate, and audit Airlock MCP gateway policies (`airlock.yaml`), per-agent allow/ask/deny rules, HITL approval providers, and CLI/OpenAPI tool discovery. Use whenever working with an Airlock gateway or writing/linting `airlock.yaml`.
---

# Airlock MCP Gateway Skill

Airlock (`airlock-bot`) is a permissions-aware MCP gateway sitting between AI agents and downstream MCP servers, CLI tools, REST APIs, and built-in `http`/`exec` backends.

## Key Config Rules

- Top-level keys: `providers` (not `mcps`), `profiles` (reusable rule sets inherited via `extends`), `agents`, `approvals` (not `hitl`), `audit`.
- Agent policy buckets: `allow`, `ask` (human approval required), `deny`.
- Precedence: most specific matching pattern wins; ties break `deny > remember_allow > ask > allow`; unmatched tools default to deny.
- Stdio mode (`--agent <name>`) uses stdin/stdout for MCP, so never pair `--agent` with `approvals.provider.type: stdio`. Use `dashboard`, `tui`, `macos`, `telegram`, or `openclaw`.

## Essential CLI Commands

```bash
# Validate a policy file strictly without resolving external secrets
npx airlock-bot config check --config airlock.yaml --strict --no-resolve

# Inspect effective rules for an agent or reverse-lookup tool access
npx airlock-bot explain claude-code --config airlock.yaml
npx airlock-bot who-can "github/*" --config airlock.yaml
npx airlock-bot lint --config airlock.yaml

# Auto-discover CLI commands or OpenAPI endpoints into YAML
npx airlock-bot discover cli git --fig --output git-commands.yaml
npx airlock-bot discover api ./openapi.yaml --output api-tools.yaml

# Launch the browser command center for provider health and policy editing
npx airlock-bot run --config airlock.yaml
```

Always run `config check --strict` and `lint` after editing `airlock.yaml`.
