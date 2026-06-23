# Config Reference

Airlock config is YAML. Everything lives in a single file (typically `airlock.yaml`). The config hot-reloads on save — no restart needed.

## Top-level sections

```yaml
providers: # MCP servers and built-ins
profiles: # Reusable permission sets
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
  airlock: builtin
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

`provider` may also be a list when you want multiple approval surfaces. For
example, a self-hosted VPS can keep the dashboard enabled while also sending
native APNs pushes to registered iOS devices:

```yaml
approvals:
  provider:
    - type: dashboard
      host: 0.0.0.0
      port: 4112
    - type: ios
      team_id: ${APPLE_TEAM_ID}
      key_id: ${APNS_KEY_ID}
      key_path: /config/AuthKey_XXXXXXXXXX.p8
      bundle_id: com.airlock.companion.ios
      production: true
      interruption_level: time-sensitive
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

Host blocking for built-in HTTP and OpenAPI tools. Airlock resolves domain names before outbound requests and fails closed if any resolved address is blocked or DNS cannot be verified.

Known limitation: this is a static DNS check. Full DNS-rebinding protection needs a pinned-resolution HTTP transport that connects to the verified IP while preserving the original hostname for Host, SNI, and certificate validation.

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
  expose_tools_api: true
  allowed_origins:
    - https://airlock.example.com
  management_api:
    enabled: true
    api_secret: '${MANAGEMENT_API_SECRET}'
    host: 127.0.0.1
    port: 4113
    insecure_remote_bind: false
    expose_hook_api: true
```

For a self-hosted or remote deployment, keep Airlock behind a TLS/authenticated
edge or a private network, and keep the Airlock listener private when possible.
If `server.host` is not loopback, Airlock requires
`auth_required: true` and per-agent tokens at config load time. When Airlock is
bound to loopback behind a reverse proxy, set `require_agent_tokens: true` to
enforce the same profile isolation.

The `server` listener is the agent data-plane. It serves MCP transports
(`/agents/:agentId/mcp`, `/agents/:agentId/sse`, `/agents/:agentId/messages`)
and, when `expose_tools_api` is true, the REST agent tool API
(`/agents/:agentId/tools` and `/agents/:agentId/tools/invoke`).

- `api_secret` is the data-plane fallback credential for tools API and MCP
  routes when an agent has no token. If an agent has `token`,
  `/agents/:agentId/tools*` and MCP routes require that agent token instead.
- `auth_required` rejects unauthenticated requests even when no secret/token is
  configured.
- `require_agent_tokens` requires every configured agent to have its own token.
  This prevents the global `api_secret` from becoming a fallback MCP credential
  for tokenless profiles.
- `allowed_origins` is an exact allowlist for browser `Origin` headers. Requests
  without `Origin` are allowed so non-browser MCP clients keep working.
- `expose_tools_api` controls the REST agent tool API on the data-plane
  listener. It is an agent-facing execution API and uses the same per-agent
  authentication model as MCP routes.
- `management_api.enabled` starts a separate control-plane listener for
  `/health`, `/hitl/*`, `/audit`, the dashboard approval bridge (`/events`,
  `/approve`, `/deny`, `/version*`), `/mobile/*`, `/admin/tools`, and `/hook`.
  It is disabled by default. When enabled, every agent must set `token` so the
  data-plane fallback cannot become an implicit agent credential.
- `management_api.api_secret` protects the control-plane listener. If unset,
  Airlock temporarily falls back to `server.api_secret` for backward
  compatibility and emits a deprecation warning: `management_api is using
  server.api_secret; set server.management_api.api_secret to separate the
  control-plane secret from the data-plane fallback.` If both secrets resolve to
  the same value, config validation warns so operators can rotate one.
- `management_api.host` defaults to `127.0.0.1`. Binding it beyond loopback
  requires `management_api.insecure_remote_bind: true`; without that explicit
  opt-in, config validation refuses to start.
- `management_api.port` defaults to `4113` and must not equal `server.port`.
  The agent data-plane and control-plane cannot share a socket.
- `management_api.expose_hook_api` controls `/hook` on the management listener.

`expose_management_api` and `expose_hook_api` are deprecated aliases for one
release. They still map into `management_api`, but new configs should use the
explicit block above.

To split an existing single-secret deployment, generate a fresh
`MANAGEMENT_API_SECRET`, set
`server.management_api.api_secret: '${MANAGEMENT_API_SECRET}'`, recreate or
restart Airlock, and update companion apps or dashboards to send
`Authorization: Bearer $MANAGEMENT_API_SECRET`. Keep `server.api_secret` only
as the data-plane fallback, or remove it when every agent has its own token and
no fallback credential is needed. Per-device companion tokens are a future
hardening step so one device can be revoked without rotating the shared
management secret.

For a public MCP-only listener, disable the non-MCP APIs and use per-agent tokens:

```yaml
server:
  port: 4111
  host: 127.0.0.1
  auth_required: true
  require_agent_tokens: true
  expose_tools_api: false
  allowed_origins:
    - https://airlock.example.com
  management_api:
    enabled: false

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
