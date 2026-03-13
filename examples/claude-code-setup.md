# Claude Code Setup (stdio mode)

Airlock can act as an MCP server for Claude Code using stdio transport.

## Add to Claude Code MCP config

In `~/.claude/mcp.json` (or `.claude/mcp.json` in your project):

```json
{
  "mcpServers": {
    "airlock": {
      "command": "airlock",
      "args": ["--agent", "claude-code", "--config", "/etc/airlock/gateway.yaml"]
    }
  }
}
```

Or using `npx` if not globally installed:

```json
{
  "mcpServers": {
    "airlock": {
      "command": "npx",
      "args": [
        "-y",
        "airlock-bot",
        "--agent",
        "claude-code",
        "--config",
        "/etc/airlock/gateway.yaml"
      ]
    }
  }
}
```

## What This Does

- Claude Code connects to Airlock over stdio
- Airlock presents only the tools allowed for the `claude-code` agent
- All tool calls are logged to the audit database
- Tools requiring HITL will block until approved (or timeout)

## Example Agent Config

```yaml
agents:
  claude-code:
    allow:
      - 'filesystem/*'
      - 'github/list*'
      - 'github/get*'
      - 'http/get'
    exec:
      allow:
        - 'git status'
        - 'git diff*'
        - 'npm test'
      deny:
        - '*'
```

## Testing

```sh
# Verify the agent works
airlock --agent claude-code --config examples/gateway.yaml
```

Then use MCP Inspector or connect from Claude Code to verify:

- `list_tools` returns only allowed tools
- Denied tools are absent from the manifest
- Audit log is populated after calls
