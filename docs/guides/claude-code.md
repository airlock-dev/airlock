# Claude Code Setup

Airlock works especially well with Claude Code in stdio mode.

## Basic MCP config

```json
{
  "mcpServers": {
    "airlock": {
      "command": "airlock",
      "args": ["--agent", "claude-code", "--config", "/path/to/airlock.yaml"]
    }
  }
}
```

## Why stdio mode is good here

With `--agent`, Airlock:

- skips the HTTP server
- exposes only the tools for that agent
- connects only to MCP providers the agent actually references

## Recommended first policy

Start with narrow read-heavy access, then expand intentionally.
