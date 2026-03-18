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

## Approval provider gotcha

Do **not** use the `stdio` approval provider when running Airlock with `--agent`.

In stdio mode, the MCP transport already uses stdin/stdout, so the `stdio` HITL provider would conflict with that transport.

For local development, prefer:

- [dashboard](/guides/local-approvals)
- [macOS](/guides/local-approvals#macos-companion)
- `tui` if you want terminal-native approval without stealing the MCP stream

## Recommended first policy

Start with narrow read-heavy access, then expand intentionally.

## Related guides

- [Quickstart](/quickstart)
- [Local Approval UX](/guides/local-approvals)
- [Examples](/reference/examples)
