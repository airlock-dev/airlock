# Config Reference

Airlock config is YAML. Everything lives in a single file (typically `airlock.yaml`). The config hot-reloads on save — no restart needed.

## Top-level sections

```yaml
providers: # MCP servers and built-ins
profiles: # Reusable permission sets
value_sets: # Reusable argument value lists
arg_dimensions: # Reusable tool-argument bindings for arg_scope
sandbox_presets: # Reusable sandbox envelopes
clis: # CLI tools exposed as MCP tools
apis: # REST APIs exposed as MCP tools
agents: # Per-agent policy and config
approvals: # Global approval provider config
middleware: # Middleware pipeline config
security: # Host blocking, domain allowlists
audit: # Audit log settings
server: # Gateway server settings
```

## `providers`

Declares upstream tool sources.

```yaml
providers:
  # MCP server over stdio
  github:
    type: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-github']
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN}'

  # MCP server over SSE
  remote:
    type: sse
    url: https://tools.example.com/sse
    headers:
      Authorization: 'Bearer ${TOKEN}'

  # MCP server over streamable HTTP (with optional OAuth)
  cloud:
    type: http
    url: https://mcp.example.com
    oauth: true
    client_id: ${CLIENT_ID}
    client_secret: ${CLIENT_SECRET}
    oauth_callback_port: 9876

  # Built-ins
  exec: builtin
  http: builtin
  python: builtin
```

## `profiles`

Reusable permission sets. See [Composable Profiles](/guides/profiles).

```yaml
profiles:
  readonly:
    allow:
      - '*/list*'
      - '*/get*'
      - http/get
  developer:
    extends: [readonly]
    allow:
      - github/*
      - git/*
    ask:
      - github/create_pr
```

Profiles may extend other profiles. Profile inheritance is resolved once at config load, before agents consume profiles. Unknown profile references and profile cycles are fatal config errors.

Config parsing is strict: unknown or misspelled keys are fatal instead of being
silently ignored. Run `airlock config check ./airlock.yaml` before deployment to
validate schema and semantic checks, including argument policy references.

## `value_sets` and `arg_dimensions`

Reusable argument controls for `arg_scope`.

```yaml
value_sets:
  personal_recipients:
    - '+16085153685' # Quote +1-style strings so YAML does not parse them as numbers.

arg_dimensions:
  sms_recipient:
    bindings:
      twilio/send_sms: to

profiles:
  personal-sms:
    arg_scope:
      sms_recipient:
        in: personal_recipients
        label: Personal phone
```

`arg_scope` references an `arg_dimension`, and the dimension maps that abstract
scope onto concrete tool arguments. At load time, Airlock expands scopes into
runtime `arg_policy` constraints. Unknown dimensions, unknown value sets, empty
bindings, and scopes that would apply no effective constraints are reported at
config load.

## `sandbox_presets`

Reusable sandbox envelopes. See [Sandboxing](/concepts/sandboxing).

```yaml
sandbox_presets:
  local_transform:
    filesystem:
      allow_read: ['.']
      allow_write: ['/tmp']
      deny_read: ['~/.ssh', '~/.aws', '.env']
      deny_write: ['.']
    network:
      allowed_domains: []
      denied_domains: []
```

## `clis`

CLI tools exposed as named MCP tools. See [CLI Discovery](/guides/cli-discovery).

```yaml
clis:
  git:
    discovered: ./git-commands.yaml
    shell: /bin/bash
    max_output_bytes: 30000
    commands:
      status:
        exec: git status
        params: {}
      log:
        exec: 'git log --oneline -n {count}'
        params:
          count:
            type: number
            required: false
            default: 10
```

## `apis`

REST APIs exposed as MCP tools. See [API Discovery](/guides/api-discovery).

```yaml
apis:
  petstore:
    spec: ./petstore.json
    base_url: https://petstore.example.com/v1
    auth:
      type: bearer # or "basic"
      token: ${TOKEN}
    timeout_ms: 30000
    max_response_bytes: 1048576
```

## `agents`

Per-agent policy configuration.

```yaml
agents:
  claude-code:
    extends: [readonly, developer] # Inherit from profiles
    allow:
      - github/*
    ask:
      - github/create_pr
    remember_allow:
      - tool: github/create_pr
        expires_at: '2026-05-26T11:00:00.000Z'
      - tool: github/list_prs
    deny:
      - exec/run

    exec: # Shell command sub-policy
      allow: ['git status', 'npm test*']
      ask: ['git push*']
      deny: ['sudo *', 'rm -rf *']
      env:
        PATH: '/usr/local/bin:/usr/bin:/bin'

    http: # HTTP domain restrictions
      domain_allowlist: ['api.github.com', '*.sentry.io']

    arg_policy: # Per-tool argument constraints
      google_workspace/manage_event:
        calendar_id:
          equals: work-calendar-id@group.calendar.google.com
          label: Work
        action:
          allow: [create, update, delete]

    arg_scope: # Reusable argument constraints via arg_dimensions
      sms_recipient:
        in: personal_recipients

    sandbox: # Agent-level sandbox
      enabled: true
      presets: [local_transform]

    tool_overrides: # Tool variants
      python/sandboxed:
        alias_of: exec/run
        description: 'Sandboxed Python'
        sandbox_presets: [local_transform]
      gcal_work_write:
        alias_of: google_workspace/manage_event
        description: 'Manage events on the Work calendar only. calendar_id must be work-calendar-id@group.calendar.google.com.'
        args:
          calendar_id:
            equals: work-calendar-id@group.calendar.google.com
            label: Work
```

## `approvals`

Global approval provider config. See [HITL Providers](/reference/hitl-providers).

```yaml
approvals:
  provider:
    type: telegram
    bot_token: '${TELEGRAM_BOT_TOKEN}'
    chat_id: '${TELEGRAM_CHAT_ID}'
  timeout_ms: 300000
  batch_window_ms: 10000
```

## `middleware`

Middleware pipeline config. See [Middleware Pipeline](/concepts/middleware).

```yaml
middleware:
  injection_detector:
    backend: regex
    mode: escalate

  sensitivity_classifier:
    mode: detect
    threshold: 0.7

  canary_tokens: true

  output_injection:
    mode: mangle

  untrusted_envelope: true

  rate_limiter:
    max_requests: 100
    window_ms: 60000
    per: agent

  output_size_limiter:
    max_lines: 200
    max_chars: 30000

  output_summarizer:
    model: claude-haiku-4-5-20251001
    threshold_chars: 10000
```

## `security`

Host blocking for built-in HTTP tools.

```yaml
security:
  blocked_hosts:
    - '127.0.0.1'
    - '::1'
    - 'localhost'
    - '10.*'
    - '192.168.*'
    - '172.16.*'
    - '169.254.*'
  allowed_local:
    - 'host.docker.internal'
```

## `audit`

Audit log settings.

```yaml
audit:
  redact_fields:
    - password
    - token
    - secret
    - authorization
    - api_key
```

## `server`

Gateway server settings (used in non-stdio mode).

```yaml
server:
  port: 4111
  host: 127.0.0.1
  api_secret: '${AIRLOCK_API_SECRET}'
  auth_required: true
  require_agent_tokens: true
  allowed_origins:
    - https://airlock.example.com
  expose_management_api: false
  expose_tools_api: false
  expose_hook_api: false
```

For a self-hosted or remote deployment, keep Airlock behind a TLS/authenticated
edge or a private network, and keep the Airlock listener private when possible.
If `server.host` is not loopback, Airlock requires
`auth_required: true` and per-agent tokens at config load time. When Airlock is
bound to loopback behind a reverse proxy, set `require_agent_tokens: true` to
enforce the same profile isolation.

- `api_secret` protects management, hook, tools API, and MCP routes for agents
  without their own token.
- `auth_required` rejects unauthenticated requests even when no secret/token is
  configured.
- `require_agent_tokens` requires every configured agent to have its own token.
  This prevents the global `api_secret` from becoming a fallback MCP credential
  for tokenless profiles.
- `allowed_origins` is an exact allowlist for browser `Origin` headers. Requests
  without `Origin` are allowed so non-browser MCP clients keep working.
- `expose_management_api` controls `/health`, `/hitl/*`, `/audit`, the
  dashboard approval bridge (`/events`, `/approve`, `/deny`, `/version*`), and
  `/admin/tools`.
- `expose_tools_api` controls `/agents/:agentId/tools` and
  `/agents/:agentId/tools/invoke`.
- `expose_hook_api` controls `/hook`.

For a public MCP-only listener, disable the non-MCP APIs and use per-agent tokens:

```yaml
server:
  port: 4111
  host: 127.0.0.1
  auth_required: true
  require_agent_tokens: true
  allowed_origins:
    - https://airlock.example.com
  expose_management_api: false
  expose_tools_api: false
  expose_hook_api: false

agents:
  claude-code:
    token: '${CLAUDE_CODE_AIRLOCK_TOKEN}'
    allow:
      - github/list*
```

## Environment variable substitution

Any value of the form `${VAR_NAME}` is replaced with the corresponding environment variable at config load time. This works for all string values in the config.

## Example configs

- `examples/gateway.yaml` — fully annotated reference config
- `examples/profiles.yaml` — composable profile examples
- `examples/sandbox-presets.yaml` — sandbox preset and tool variant examples
- `examples/local-dev.yaml` — minimal local development config
