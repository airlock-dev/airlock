# CLI Commands

## Run the gateway

Start Airlock as a combined SSE/HTTP gateway server (default port 4111):

```bash
airlock --config airlock.yaml
```

For split deployments, run only the MCP/runtime gateway and disable the
in-process dashboard provider:

```bash
airlock gateway --config airlock.yaml
```

## Run the standalone dashboard

Start the admin dashboard as a separate process. It edits the local config file
and talks to the gateway management API for status, audit, and approvals.

```bash
airlock dashboard \
  --config airlock.yaml \
  --gateway-url http://127.0.0.1:4113
```

Options:

| Flag               | Description                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------- |
| `--config`, `-c`   | Path to airlock.yaml config file                                                             |
| `--port`, `-p`     | Dashboard port (default: 4177)                                                               |
| `--host`           | Bind host (default: `127.0.0.1`)                                                             |
| `--gateway-url`    | Gateway management API URL (default: `http://127.0.0.1:4113`)                                |
| `--gateway-secret` | Gateway admin bearer token (defaults to `AIRLOCK_GATEWAY_SECRET`, then `AIRLOCK_API_SECRET`) |

## Open the command center

Start the local browser command center for provider health, MCP status, tool discovery, and permission editing:

```bash
airlock run --config airlock.yaml
```

Options:

| Flag             | Description                         |
| ---------------- | ----------------------------------- |
| `--config`, `-c` | Path to airlock.yaml config file    |
| `--port`, `-p`   | Command center port (default: 4177) |
| `--host`         | Bind host (default: `127.0.0.1`)    |

## Run stdio mode for a specific agent

Lean mode with no HTTP server. Only connects to MCP providers the agent references:

```bash
airlock --agent claude-code --config airlock.yaml
```

## Validate local config

Run static validation without starting listeners or connecting to providers:

```bash
airlock config check --config airlock.yaml --strict
airlock config check --config airlock.yaml --strict --no-resolve
airlock config check --config airlock.yaml --strict --no-resolve --fail-on warn
```

Options:

| Flag             | Description                                            |
| ---------------- | ------------------------------------------------------ |
| `--config`, `-c` | Path to airlock.yaml config file                       |
| `--strict`       | Explicit strict mode; unknown keys are always errors   |
| `--no-resolve`   | Validate `${VAR}` references without requiring secrets |
| `--fail-on`      | Non-zero threshold: `error` (default) or `warn`        |
| `--json`         | Print machine-readable diagnostics                     |

Use `--strict --no-resolve` for CI and pre-deploy checks that should reject invalid shape, references, inheritance, and no-op argument scopes without loading production secrets. Add `--fail-on warn` when warnings such as YAML scalar footguns should block deployment too.

## Explain an agent

Show an agent's effective allow/ask/deny sets after profile inheritance, including provenance, arg scope, and precedence notes:

```bash
airlock explain claude-code --config airlock.yaml
```

By default this is offline and reads only the config file. Add `--expand` to connect to providers and expand matching patterns to concrete live tools:

```bash
airlock explain claude-code --config airlock.yaml --expand --json
```

## Reverse lookup permissions

List agents and their effective decision for a tool name or glob-like pattern:

```bash
airlock who-can "supabase/*" --config airlock.yaml
airlock who-can github/delete_repo --level deny --json
```

Decisions are computed through the shared allowlist engine and may be `allow`, `ask`, `deny`, or `default-deny`.

## Enumerate live tools

Connect to configured providers and list the live tool surface:

```bash
airlock tools --config airlock.yaml
airlock tools --provider github --grep pull --json
```

This command may start provider clients. Static commands such as `config check`, `explain` without `--expand`, `who-can`, and `lint` do not.

## Lint config hygiene

Run static hygiene checks over a valid resolved config:

```bash
airlock lint --config airlock.yaml
```

Warnings include unreferenced profiles, value sets, and argument dimensions; deny rules that do not overlap any grant; agents with an empty effective surface; and missing environment-variable references.

## Discover CLI tools

Parse `--help` output and generate Airlock config:

```bash
airlock discover cli git --output git-commands.yaml
```

Options:

| Flag             | Description                                           |
| ---------------- | ----------------------------------------------------- |
| `--output`, `-o` | Write output to file instead of stdout                |
| `--fig`          | Try Fig autocomplete specs first, fall back to --help |
| `--max-depth`    | Maximum recursion depth for subcommand discovery      |
| `--include`      | Only include specific commands (comma-separated)      |

Airlock uses three discovery strategies in order of preference:

1. **Fig specs** (if `--fig` is passed) — structured autocomplete definitions
2. **Shell completion** — hooks into Cobra, Click/Typer, Clap, and native shell completion
3. **Help text parsing** — parses `--help` output as a fallback

## Discover API tools

Generate config from an OpenAPI 3.x spec:

```bash
airlock discover api ./petstore.json --output petstore-api.yaml
```

Options:

| Flag             | Description                                      |
| ---------------- | ------------------------------------------------ |
| `--output`, `-o` | Write output to file instead of stdout           |
| `--base-url`     | Override the base URL from the spec              |
| `--include`      | Only include matching endpoints (e.g. `"GET *"`) |
| `--exclude`      | Exclude matching endpoints (e.g. `"DELETE *"`)   |

See [API Discovery](/guides/api-discovery) for a full guide.

## Configure a CLI interactively

Interactive TUI for discovering and curating CLI commands:

```bash
airlock configure-cli git
```

Features:

- Lazy-loads subcommand groups (doesn't crawl the entire tree up front)
- Toggle commands and groups on/off
- Inspect command parameters
- Search with `/`
- Export to YAML, merge into existing config, or copy to clipboard

## Configure agent permissions interactively

Interactive TUI for assigning allow/ask/deny to tools from your live MCP servers:

```bash
npm run configure-agent -- --config ./airlock.yaml --agent claude-code
```

Features:

- Create agents and profiles from the sidebar
- New agents get a generated bearer token for MCP clients
- Connects to your configured MCP servers and lists all available tools
- Navigate with `j/k`, set permissions with `a`/`s`/`d`
- Bulk-set entire providers
- Export: edit config directly, copy to clipboard, or print YAML

## Setup OpenClaw integration

Install the Airlock bridge plugin for OpenClaw:

```bash
airlock setup openclaw
```

Copies the bundled plugin into `~/.openclaw/extensions/airlock-bridge/`, installs dependencies, and prints next steps. See [OpenClaw Setup](/guides/openclaw).

## Common flags

| Flag             | Description                      |
| ---------------- | -------------------------------- |
| `--config`, `-c` | Path to airlock.yaml config file |
| `--agent`        | Agent name for stdio mode        |
| `--version`      | Print version                    |
| `--help`         | Print help                       |
