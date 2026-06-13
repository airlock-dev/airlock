# Permissions

Airlock evaluates tool access with one simple model:

- `deny` blocks the call
- `ask` requires human approval
- `allow` permits the call immediately
- anything unmatched is default-denied

The companion dashboard may also add `remember_allow` entries. These are per-agent, exact-tool exceptions; if `expires_at` is present, the exception is ignored after that timestamp.

Precedence is always:

```text
deny > remember_allow > ask > allow > default-deny
```

## Policy is per agent

Each agent gets its own policy surface. That means `claude-code` can be more restrictive than `helena`, even when both connect through the same Airlock instance.

```yaml
agents:
  claude-code:
    allow:
      - github/list*
      - github/get*
    deny:
      - exec/run

  helena:
    allow:
      - github/*
      - exec/run
    ask:
      - github/create_pr
```

## Tool hiding

Denied tools are not just blocked at call time — they are completely removed from the tool list. The agent never sees them in the MCP manifest. It cannot discover that they exist.

This is important because agents often try to use tools they can see, even if they're told not to. Hiding the tool entirely removes the temptation and the attack surface.

## Glob patterns

Allow, ask, and deny lists support glob-style wildcards:

- `github/*` — all tools in the github namespace
- `github/list*` — tools starting with "list" in the github namespace
- `*/get*` — any tool starting with "get" in any namespace
- `exec/run` — exact match

## Profiles reduce repetition

Use `profiles` when several agents share a policy baseline:

```yaml
profiles:
  readonly:
    allow:
      - github/list*
      - github/get*
      - http/get

agents:
  claude-code:
    extends: [readonly]

  helena:
    extends: [readonly]
    allow:
      - github/*
    ask:
      - github/create_pr
```

Profiles merge with the same precedence. Agent-level rules apply on top. See [Composable Profiles](/guides/profiles) for the full guide.

## Exec policy

Two checks apply to shell access:

1. Can the agent call the tool at all? (allow/ask/deny on `exec/run`)
2. Which command strings are legal once inside the tool? (exec sub-policy)

This lets you say things like "the agent may call `exec/run`, but only for these specific commands":

```yaml
agents:
  claude-code:
    allow:
      - exec/run
    exec:
      allow:
        - 'git status'
        - 'git diff*'
        - 'npm test*'
      ask:
        - 'git push*'
        - 'git commit*'
      deny:
        - 'sudo *'
        - 'rm -rf *'
        - 'curl *'
      env:
        PATH: '/usr/local/bin:/usr/bin:/bin'
```

Exec policy uses the same glob matching and deny > ask > allow > default-deny precedence.

## HTTP domain allowlists

Per-agent domain restrictions for the built-in HTTP tools:

```yaml
agents:
  helena:
    http:
      domain_allowlist:
        - 'api.github.com'
        - '*.sentry.io'
        - 'api.notion.so'
```

Localhost and RFC-1918 private ranges are blocked by default for HTTP tools, preventing agents from reaching internal services or the Airlock management API itself. See [Security defaults](/concepts/providers-and-tools#security-defaults) for details.

## Tool variants

The same underlying tool can be exposed under multiple names with different permission levels using `tool_overrides` and `alias_of`. See [Sandbox Presets and Variants](/concepts/sandboxing) for this pattern.
