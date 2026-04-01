# CLI Commands

## Run the gateway

Start Airlock as an SSE/HTTP gateway server (default port 4111):

```bash
airlock --config airlock.yaml
```

## Run stdio mode for a specific agent

Lean mode with no HTTP server. Only connects to MCP providers the agent references:

```bash
airlock --agent claude-code --config airlock.yaml
```

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
