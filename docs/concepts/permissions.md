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

## Approval context

Tools routed through `ask` are annotated in the MCP tool schema. Agents must
include `_airlock.reason` with the call, explaining why they are requesting the
action now. Airlock strips `_airlock` before forwarding the call to the upstream
tool, but includes the reason in the approval request shown to the user.

The built-in notification tools `airlock/ask_user`, `airlock/notify_user`, and
`airlock/log` cannot themselves be routed through `ask`; they must be allowed or
denied.

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

## Argument policy

Some tools expose broad capabilities behind one tool name. For example, a calendar
tool might take a `calendar_id` argument where one calendar is safe to edit and
another should remain read-only.

Use `arg_policy` to constrain specific argument values before execution:

```yaml
agents:
  helena:
    allow:
      - google_workspace/get_events
      - google_workspace/manage_event

    arg_policy:
      google_workspace/manage_event:
        calendar_id:
          equals: work-calendar-id@group.calendar.google.com
          label: Work
        action:
          allow: [create, update, delete]
```

Argument policy never rewrites caller arguments. If a constrained argument is
missing or has the wrong value, Airlock denies the call with an actionable tool
error that names the argument, the rejected value, and the allowed value. This
keeps the agent's world-model honest: it retries with the permitted value instead
of believing it touched a different resource.

By default a failing constraint denies. Set `on_miss: ask` to escalate to
human-in-the-loop approval instead — a soft scope where anything outside the
allowlist prompts you rather than being blocked outright:

```yaml
    arg_policy:
      posthog/exec:
        command:
          # reads run freely; any other command (writes, deletes, admin) asks first
          glob_allow: [tools, 'search *', 'info *', 'schema *', 'call query-* *', 'call *-get *', 'call *-list *']
          on_miss: ask
```

`on_miss` composes with the usual precedence: **deny always wins**. If any
constraint on a call hard-denies (`on_miss: deny`, the default), that beats a
pending `ask` from another constraint. Otherwise, if at least one `on_miss: ask`
constraint failed, the call goes through the HITL gate for approval.

## Tool variants

The same underlying tool can be exposed under multiple names with different permission levels using `tool_overrides` and `alias_of`. See [Sandbox Presets and Variants](/concepts/sandboxing) for this pattern.

Tool variants can also carry argument policy. This is useful when each variant
represents one constrained resource:

```yaml
agents:
  helena:
    allow:
      - gcal_work_write
    ask:
      - gcal_family_write
    deny:
      - google_workspace/manage_event

    tool_overrides:
      gcal_work_write:
        alias_of: google_workspace/manage_event
        description: >
          Manage events on the Work calendar only.
          calendar_id must be work-calendar-id@group.calendar.google.com.
        args:
          calendar_id:
            equals: work-calendar-id@group.calendar.google.com
            label: Work

      gcal_family_write:
        alias_of: google_workspace/manage_event
        description: >
          Manage events on the Family calendar only.
          calendar_id must be family-calendar-id@group.calendar.google.com.
        args:
          calendar_id:
            equals: family-calendar-id@group.calendar.google.com
            label: Family
```

The alias remains the permission unit, so `gcal_work_write` can run
autonomously while `gcal_family_write` requires approval.
