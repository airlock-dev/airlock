# Claude Code Setup

Airlock works especially well with Claude Code in stdio mode.

## Basic MCP config

Add Airlock as an MCP server in `~/.claude/mcp.json`:

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

Or without a global install:

```json
{
  "mcpServers": {
    "airlock": {
      "command": "npx",
      "args": ["airlock-bot", "--agent", "claude-code", "--config", "/path/to/airlock.yaml"]
    }
  }
}
```

## Why stdio mode is good here

With `--agent`, Airlock:

- Skips the HTTP server entirely — zero overhead
- Exposes only the tools for that agent
- Connects only to MCP providers the agent actually references
- Communicates over stdin/stdout, which is what Claude Code expects

## Recommended first policy

Start with narrow read-heavy access, then expand intentionally:

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
      - github/list*
      - github/get*
      - http/get
    ask:
      - github/create_pr
      - github/merge_pull_request
    deny:
      - exec/run

    exec:
      allow:
        - 'git status'
        - 'git diff*'
        - 'npm test*'
      deny:
        - 'sudo *'
        - 'rm -rf *'

approvals:
  provider:
    type: dashboard # Or tui, macos, telegram, etc.
    port: 4112
  timeout_ms: 300000
```

## Adding sandboxed Python

Give Claude Code a safe scripting path that doesn't require approval:

```yaml
providers:
  exec: builtin

agents:
  claude-code:
    allow:
      - python/sandboxed
    ask:
      - python/full
    sandbox:
      enabled: true
      filesystem:
        allow_write: ['/tmp', '/private/tmp']
        deny_read: ['~/.ssh', '~/.aws', '.env']
        deny_write: ['.']
      network:
        allowed_domains: []
    tool_overrides:
      python/sandboxed:
        alias_of: exec/run
        description: 'Python for local transforms (no network, writes to /tmp only)'
      python/full:
        alias_of: exec/run
        description: 'Full Python after approval'
```

See [Sandboxed Python Variants](/guides/sandboxed-python) for the full pattern.

## Approval options for local dev

For local development with Claude Code, the best approval providers are:

- **dashboard** — browser-based approval queue at `http://localhost:4112`
- **tui** — terminal UI with keyboard shortcuts (if you have a spare terminal)
- **macos** — native macOS dialog popups (good when you're in another app)
- **Companion app** — native menu bar app with notifications ([download](https://github.com/airlock-dev/airlock/releases/latest))

## Using the hook endpoint

You can also integrate Airlock with Claude Code's hook system via the `/hook` endpoint. See [Hook Endpoint](/guides/hook-endpoint).
