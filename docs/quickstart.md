# Quickstart

This gets Airlock in front of Claude Code with a runnable, no-secret starter
config.

## Install

```bash
npm install -g airlock-bot
```

## Download the starter config

```bash
curl -fsSL -o airlock.yaml \
  https://raw.githubusercontent.com/airlock-dev/airlock/main/examples/airlock.yaml

airlock config check --config airlock.yaml
```

The checked-in [`examples/airlock.yaml`](https://github.com/airlock-dev/airlock/blob/main/examples/airlock.yaml)
uses only the built-in HTTP and exec providers, so it starts without API keys
or another MCP server. Its command and domain policies fail closed: safe
read-only operations are allowed, mutating operations require approval, and
everything else is denied.

## Run Airlock in stdio mode

```bash
airlock --agent claude-code --config airlock.yaml
```

## Wire Claude Code to Airlock

```json
{
  "mcpServers": {
    "airlock": {
      "command": "airlock",
      "args": ["--agent", "claude-code", "--config", "/absolute/path/to/airlock.yaml"]
    }
  }
}
```

For a network MCP client, start the combined gateway instead:

```bash
airlock --config airlock.yaml
```

Then connect to either transport:

```text
http://127.0.0.1:4111/agents/claude-code/mcp  # streamable HTTP
http://127.0.0.1:4111/agents/claude-code/sse  # SSE
```

## Next steps

- discover a CLI into named tools: [CLI Discovery Wizard](/guides/cli-discovery)
- add more nuanced policy: [Permissions](/concepts/permissions)
- add safe sandboxed execution variants: [Sandboxed Python Variants](/guides/sandboxed-python)
