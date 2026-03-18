# Quickstart

This gets Airlock in front of Claude Code with a small but real config.

## Install

```bash
npm install -g airlock-bot
```

## Create a minimal config

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

agents:
  claude-code:
    allow:
      - 'github/list*'
      - 'github/get*'
      - 'http/get'
    ask:
      - 'github/create_pr'
    deny:
      - 'exec/run'

approvals:
  provider:
    type: stdio
  timeout_ms: 300000
```

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

## Next steps

- discover a CLI into named tools: [CLI Discovery Wizard](/guides/cli-discovery)
- add more nuanced policy: [Permissions](/concepts/permissions)
- add safe sandboxed execution variants: [Sandboxed Python Variants](/guides/sandboxed-python)
