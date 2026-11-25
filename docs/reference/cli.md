# CLI Commands

## Run the gateway

Start Airlock as a combined streamable HTTP and SSE gateway server (default port 4111):

```bash
airlock --config airlock.yaml
```

`airlock serve --config airlock.yaml` is an explicit alias for the same
combined mode. The data-plane endpoints are
`/agents/:agentId/mcp` (streamable HTTP) and `/agents/:agentId/sse` (SSE).

The streamable HTTP endpoint is stateless: it speaks MCP 2026-07-28 to clients that send the
per-request envelope and serves 2025-era clients without issuing an `Mcp-Session-Id`, so there is
no per-agent session cap on it. The SSE endpoint is the deprecated 2024-11-05 transport and keeps
its session limits (`security.limits`). See [Connecting HTTP Agents](/guides/http-agents).

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

| Flag                     | Description                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| `--config`, `-c`         | Path to airlock.yaml config file                                                             |
| `--port`, `-p`           | Dashboard port (default: 4177)                                                               |
| `--host`                 | Bind host (default: `127.0.0.1`)                                                             |
| `--insecure-remote-bind` | Allow binding the unauthenticated dashboard beyond loopback                                  |
| `--gateway-url`          | Gateway management API URL (default: `http://127.0.0.1:4113`)                                |
| `--gateway-secret`       | Gateway admin bearer token (defaults to `AIRLOCK_GATEWAY_SECRET`, then `AIRLOCK_API_SECRET`) |
| `--public-url`           | Gateway URL agents connect to, used in setup snippets (defaults to `AIRLOCK_PUBLIC_URL`)     |

The optional policy assistant reads `AIRLOCK_ASSISTANT_BASE_URL`, `AIRLOCK_ASSISTANT_MODEL`
and `AIRLOCK_ASSISTANT_API_KEY`. See [Dashboard](/guides/dashboard#policy-assistant).

## Open the command center

Start the local browser command center for provider health, MCP status, tool discovery, and permission editing:

```bash
airlock run --config airlock.yaml
```

Options:

| Flag                     | Description                                                           |
| ------------------------ | --------------------------------------------------------------------- |
| `--config`, `-c`         | Path to airlock.yaml config file                                      |
| `--port`, `-p`           | Command center port (default: 4177)                                   |
| `--host`                 | Bind host (default: `127.0.0.1`)                                      |
| `--insecure-remote-bind` | Allow binding the unauthenticated command center beyond loopback      |
| `--public-url`           | Gateway URL used in setup snippets (defaults to `AIRLOCK_PUBLIC_URL`) |

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

Provider clients started by `tools`, `lint`, `explain --expand` and the dashboard probes open OAuth
token storage **read-only**: they use the stored access token but never refresh, rewrite, or
invalidate a grant. Only the process holding the OAuth writer lock (the gateway, or a stdio agent
when no gateway runs) refreshes tokens.

## Lint config hygiene

Run static hygiene checks over a valid resolved config:

```bash
airlock lint --config airlock.yaml
airlock lint --config airlock.yaml --verbose
airlock lint --config airlock.yaml --fail-on info
```

`lint` is an opinionated hygiene command. `config check` remains the correctness and CI gate for schema, security, and fail-closed validation.

Rules have stable ids and default severities:

| Rule               | Default | Meaning                                                             |
| ------------------ | ------- | ------------------------------------------------------------------- |
| `dead-deny`        | `info`  | A deny pattern does not overlap any allow or ask pattern            |
| `unused-profile`   | `info`  | A profile is registered but not inherited by any agent              |
| `unused-value-set` | `info`  | A value set is not referenced by arg scope or arg policy            |
| `unused-dimension` | `info`  | An argument dimension is not referenced by any arg scope            |
| `empty-agent`      | `warn`  | An agent resolves to zero allow/ask tools                           |
| `missing-env-ref`  | `warn`  | A `${VAR}` reference is unset; the value is not read by lint        |
| `unresolvable-ref` | `warn`  | An `extends`, `arg_scope`, or value set reference is missing        |
| `unallocated-tool` | `info`  | A provider serves a tool no agent can reach (`--with-catalog`)      |
| `dead-allow`       | `warn`  | A grant names a tool the provider does not serve (`--with-catalog`) |

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
| `--with-catalog` | Connect to providers and check policy against the live tool list                      |
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
| `--exclude`      | Exclude specific commands (comma-separated)           |

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

Options:

| Flag             | Description                                                       |
| ---------------- | ----------------------------------------------------------------- |
| `--config`, `-c` | Config file the edit action writes to (default: `./airlock.yaml`) |
| `--fig`          | Try Fig autocomplete specs first                                  |
| `--max-depth`    | Maximum subcommand recursion depth (default: 2)                   |
| `--output`, `-o` | Write YAML to this file instead of opening the action picker      |

Features:

- Lazy-loads subcommand groups (doesn't crawl the entire tree up front)
- Toggle commands and groups on/off
- Inspect command parameters
- Search with `/`
- Export to YAML, edit the `--config` file directly, copy to clipboard, or write a
  generated `<tool>-commands.yaml`

## Configure agent permissions interactively

Interactive TUI for assigning allow/ask/deny to tools from your live MCP servers:

```bash
airlock configure-agent --config ./airlock.yaml --agent claude-code
```

Options:

| Flag              | Description                                                  |
| ----------------- | ------------------------------------------------------------ |
| `--config`, `-c`  | Path to airlock.yaml config file (default: `./airlock.yaml`) |
| `--agent`, `-a`   | Agent name to use in output (default: `agent`)               |
| `--verbose`, `-v` | Show MCP server output (suppressed by default)               |

Features:

- Connects to your configured MCP servers and lists all available tools
- Pre-populates decisions from an existing agent when one is present
- Navigate with `j/k`, set permissions with `a`/`s`/`d`
- Bulk-set entire providers
- Export: edit config directly, copy to clipboard, or print YAML

## Edit config in the browser

Start a loopback-only browser editor for providers, profiles, agents, and
permissions:

```bash
airlock configure-web --config ./airlock.yaml
```

It accepts the same `--config`, `--port` (default 4177), `--host`,
`--insecure-remote-bind`, and `--public-url` flags as `airlock run`.

This editor updates the local YAML file and writes a backup before saving. Use
`airlock run` when you also want live provider health, MCP status, and tool
discovery in the same local command center.

## Inspect and restore OAuth grants

Airlock-held OAuth grants (`oauth: true`) live in `~/.airlock/oauth/<provider>.json`. Every
replacement of a grant — a refresh rotation, a new authorization, a restore — keeps the previous
version in `~/.airlock/oauth/.history/<provider>/` (last 10 kept, owner-only permissions). The new
grant is made durable first; the backup is written afterwards and a failing backup never blocks it.

```bash
airlock oauth status [provider]            # what is stored, unresolved refreshes, lock holder
airlock oauth history <provider>           # backups, newest first
airlock oauth restore <provider> <version> # put a backup back (the replaced grant is backed up too)
```

None of these print token values.

A restore never races a refresh. When another process (normally the gateway, also when you run the
command through `docker exec`) holds the OAuth writer lock, the restore is handed to that process,
which applies it between refreshes; the command waits for the answer (`--wait <seconds>`, default
30). With no live holder the command takes the lock for the duration of the restore. `--force`
takes the lock over from a holder that does not answer: that process turns read-only for OAuth until
it re-acquires the lock, and a refresh it had in flight is parked for adoption rather than lost.

Airlock never deletes a grant on its own. An issuer answering `invalid_grant`, an issuer URL change,
or a metadata outage leaves the stored grant in place; refresh is retried with exponential backoff
(1 minute, doubling to 30 minutes, forever). State is reported under `oauthHealth` in `/health` and
on the provider status, never paged:

| State                 | Meaning                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `refresh_failing`     | The issuer (or the network before sending) failed; the token was not spent                                   |
| `refresh_ambiguous`   | A refresh may have reached the issuer but the answer was lost, or a process stopped mid-exchange             |
| `persistence_pending` | A refresh succeeded but the new grant could not be written yet; it is used from memory and the write retried |
| `grant_rejected`      | The issuer rejected the stored grant; a browser authorization is offered and only replaces it on success     |

Refreshes go to the endpoint that last refreshed the grant. When discovery advertises a new issuer
(`issuerChanged`), the grant moves there only after the old endpoint rejects it or is gone.

**Limits.** After an ambiguous exchange the stored refresh token is the only one Airlock has, so it
is retried — once after 5 seconds, then with backoff — at the same endpoint only. An issuer with a
reuse grace window accepts it and the grant recovers. An issuer that strictly enforces single use
and rotated the token before the answer was lost cannot be recovered from the client side: the
retry gets `invalid_grant` and status says that the earlier lost exchange probably consumed it.
Airlock never spends a refresh token unless it could first durably record the attempt.

## Setup OpenClaw integration

Install the Airlock bridge plugin for OpenClaw:

```bash
airlock setup openclaw
```

Creates `~/.openclaw/extensions/airlock-bridge` as a symlink to the bundled
plugin and prints next steps. See [OpenClaw Setup](/guides/openclaw).

## Common flags

| Flag             | Description                       |
| ---------------- | --------------------------------- |
| `--config`, `-c` | Path to airlock.yaml config file  |
| `--agent`, `-a`  | Agent name for stdio mode         |
| `--pretty`       | Human-friendly colored log output |
| `--help`         | Print help                        |
