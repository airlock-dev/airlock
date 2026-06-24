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
airlock lint --config airlock.yaml --verbose
airlock lint --config airlock.yaml --fail-on info
```

`lint` is an opinionated hygiene command. `config check` remains the correctness and CI gate for schema, security, and fail-closed validation.

Rules have stable ids and default severities:

| Rule               | Default | Meaning                                                      |
| ------------------ | ------- | ------------------------------------------------------------ |
| `dead-deny`        | `info`  | A deny pattern does not overlap any allow or ask pattern     |
| `unused-profile`   | `info`  | A profile is registered but not inherited by any agent       |
| `unused-value-set` | `info`  | A value set is not referenced by arg scope or arg policy     |
| `unused-dimension` | `info`  | An argument dimension is not referenced by any arg scope     |
| `empty-agent`      | `warn`  | An agent resolves to zero allow/ask tools                    |
| `missing-env-ref`  | `warn`  | A `${VAR}` reference is unset; the value is not read by lint |
| `unresolvable-ref` | `warn`  | An `extends`, `arg_scope`, or value set reference is missing |

By default, warnings are printed in full and each info rule is collapsed to one summary line:

```text
dead-deny: 96 (info) - [selene] github/create_or_update_file, [selene] github/push_files, [selene] github/delete_file ... +93 more
unused-profile: 7 (info) - github-write, bluebubbles-findmy, bluebubbles-groups ... +4 more
info collapsed; --verbose to list all; --quiet to hide; --fail-on info to gate.
```

Options:

| Flag             | Description                                                                           |
| ---------------- | ------------------------------------------------------------------------------------- |
| `--config`, `-c` | Path to airlock.yaml config file                                                      |
| `--verbose`      | Expand info findings instead of collapsing them                                       |
| `--quiet`        | Hide info summaries and print only warn/error findings                                |
| `--fail-on`      | Non-zero threshold: `warn` (default), `info`, or `error`                              |
| `--only`         | Run only comma-separated rule ids for this invocation                                 |
| `--disable`      | Disable comma-separated rule ids for this invocation                                  |
| `--rule`         | Override one rule for this invocation, e.g. `dead-deny=off` or `empty-agent=error`    |
| `--json`         | Print grouped findings as an array of `{ rule, severity, count, findings[] }` entries |

Use the top-level `lint:` block to permanently accept or re-grade rules:

```yaml
lint:
  disable:
    - dead-deny
  severity:
    unused-profile: warn
```

CLI flags override the config block. `--rule dead-deny=warn` re-enables and re-grades a rule disabled in config for that invocation.

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
