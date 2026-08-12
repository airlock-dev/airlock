# Config Reference

Airlock config is YAML. Everything lives in a single file (typically `airlock.yaml`). The config hot-reloads on save — no restart needed.

## Top-level sections

```yaml
providers: # MCP servers and built-ins
value_sets: # Reusable argument value lists
arg_dimensions: # Reusable tool-argument bindings for arg_scope
profiles: # Reusable permission sets
default_profile: # Optional profile every agent inherits (DRY low-risk grants)
sandbox_presets: # Reusable sandbox envelopes
clis: # CLI tools exposed as MCP tools
apis: # REST APIs exposed as MCP tools
agents: # Per-agent policy and config
approvals: # Global approval provider config
security: # Host blocking, domain allowlists
audit: # Audit log settings
server: # Gateway server settings
lint: # Static hygiene rule configuration
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
    # Override the MCP SDK's 60s default for slow providers. Keep this below the
    # consuming agent's call_execution_timeout_ms so Airlock retains the outer bound.
    request_timeout_ms: 110000

  # MCP server authenticated as the APP itself (no user, no browser)
  bot:
    type: http
    url: https://mcp.example.com
    client_credentials:
      token_url: https://api.example.com/oauth/token
      client_id: ${BOT_CLIENT_ID}
      client_secret: ${BOT_CLIENT_SECRET}
      scope: read,write

  # Built-ins
  exec: builtin
  http: builtin
  airlock: builtin
```

### App identity: `client_credentials`

`oauth: true` runs the authorization-code flow: a human authorizes in a browser and the provider
carries **that person's** identity. Everything an agent does through it lands under their name.

`client_credentials` runs the OAuth2 client-credentials grant instead — Airlock authenticates as the
**application**, with no user in the loop. Use it for autonomous agents whose writes should be
attributable to a bot rather than to whoever last clicked "authorize":

```yaml
providers:
  bot:
    type: http
    url: https://mcp.example.com
    client_credentials:
      token_url: https://api.example.com/oauth/token
      client_id: ${BOT_CLIENT_ID}
      client_secret: ${BOT_CLIENT_SECRET}
      scope: read,write # verbatim — separator is the issuer's to define
```

| Field           | Effect                                                                |
| --------------- | --------------------------------------------------------------------- |
| `token_url`     | The issuer's token endpoint                                           |
| `client_id`     | App client id (`${ENV}` supported)                                    |
| `client_secret` | App client secret (`${ENV}` supported)                                |
| `scope`         | Optional; passed through untouched, so use the issuer's own separator |

Tokens are minted on demand, cached under `~/.airlock/oauth/<provider>.client-credentials.json` at
`0600`, re-minted inside a 5-minute expiry buffer, and force-re-minted once on a `401` (rotating an
app's client secret revokes every live token, and expiry is not the only way one dies). The disk
cache is not just an optimization: issuers cap how many client-credentials tokens an app may hold at
once, so minting fresh on every restart would eventually exhaust that quota.

A provider declares **one** identity — setting both `oauth: true` and `client_credentials` is a
config error. To have both, declare two providers and grant each to different agents.

Credentials the issuer rejects outright (`invalid_client`, `unauthorized_client`, `invalid_scope`)
are reported as `auth_required` in [`credentialHealth`](./management-api.md#get-health); a `503` from
the issuer is not, so a flaky token endpoint never sends you off rotating a working secret.

### Provider instructions

MCP servers may advertise server-level `instructions` at initialize — prose describing how to use
the server as a whole. Airlock collects them from every upstream provider and re-exposes them as its
own `instructions`, composed per agent: an agent only sees sections for providers it can actually
reach.

Add `instructions` to a provider to attach your own notes — the things a vendor's docs can't know:

```yaml
providers:
  railway:
    type: http
    url: https://mcp.railway.com
    oauth: true
    instructions: >
      list-projects only returns personal-workspace projects. The Acme project is an
      invited workspace project and will NOT appear there — pass its projectId directly
      to get-status / get-logs / list-services.
    upstream_instructions: include # or `ignore` to suppress the provider's own text
```

`instructions` is operator-authored, so it is trusted: never scrubbed, never truncated. Instructions
advertised by the upstream provider are untrusted and go through the same prompt-injection scrubbing
as tool descriptions, bounded at 4000 characters.

### Credential probe

`mcpHealth` proves a provider is _reachable_. It cannot prove its _credential still works_ — those
are independent facts, and the gap between them is where outages hide: a Google Workspace sidecar
whose refresh token expired keeps answering MCP normally, so health stays green for as long as it
takes someone to notice nothing works.

`credential_probe` closes that gap by making a real, cheap, read-only call and reporting the result
as [`credentialHealth`](./management-api.md#get-health):

```yaml
providers:
  gwsPersonal:
    type: http
    url: http://gws-personal:8000/mcp
    credential_probe:
      tool: search_gmail_messages # provider-local name, unprefixed
      args: { query: 'label:receipts', page_size: 1 }
      expect_contains: 'Found' # what a HEALTHY response looks like
      interval_ms: 900000 # cache TTL; default 15m, floor 1m
      timeout_ms: 15000 # default 15s
```

Pick the cheapest read the provider offers and scope it tightly — this runs unattended, forever.

A thrown error or an `isError` result is a failure, and the failure text decides `auth_required` vs
`error`. That covers most providers. It does not cover the ones that report a dead credential as a
_successful_ text response — the Google sidecar's `ACTION REQUIRED: authorize…` arrives as a normal
200 — which is what the two matchers are for:

| Field             | Effect                                             |
| ----------------- | -------------------------------------------------- |
| `expect_contains` | A healthy response must contain this substring     |
| `reject_contains` | A healthy response must not contain this substring |

Prefer `expect_contains`, anchored on the shape of a healthy response. Both matchers scan the whole
payload, so `reject_contains` can be tripped by the phrase appearing in returned _data_ — a probe
that reads mail will eventually meet a message subject reading "Action Required".

Providers with `oauth: true` are authenticated by Airlock itself. They report negative failures
through the transport and automatically earn positive health through a cached, read-only
`listTools` probe. An explicit `credential_probe` overrides that generic check and is still
recommended when a provider can list tools even though a separate downstream credential is dead.
Non-OAuth providers without an explicit probe are reported as `unknown` rather than `ok`:
transport-up is not credential-valid, and the gateway will not imply otherwise.

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

Profiles may extend other profiles. Profile inheritance is resolved once at
config load, before agents consume profiles. Unknown profile references and
profile cycles are fatal config errors. Profiles can also carry `arg_policy`,
`arg_scope`, and `tool_overrides` entries that agents inherit alongside
allow/ask/deny rules — so the profile that grants a provider's tools can also
carry the notes an agent needs to use them correctly.

When the same tool is overridden at several levels, later sources (the agent
last) win field by field, with two exceptions that would otherwise destroy
inherited config: `description_append` accumulates, and `sandbox_presets` unions.

## `default_profile`

Optional. Names one profile that **every agent inherits automatically**, so a
low-risk grant you want everywhere (self-inspection tools, a shared notify
channel) lives in one place instead of being copied onto each agent.

```yaml
default_profile: base

profiles:
  base:
    allow:
      - airlock/status
      - airlock/list_provider_tools
```

It is prepended to each agent's `extends`, so it resolves at **lowest
precedence** — an agent can still `deny` (or `ask`-gate) anything the default
grants (`deny > ask > allow`). Because the named profile may itself `extends` a
chain, one entry can compose many. A referenced profile that does not exist is a
fatal config error. Opt a single agent out with `inherit_default: false` (see
[`agents`](#agents)).

## `value_sets` and `arg_dimensions`

Reusable argument restrictions are split into value sets and dimensions.

`value_sets` declare named non-empty lists. Use either a plain array or an
object when you want to hide the concrete values in policy-denial messages:

```yaml
value_sets:
  airlock_repos:
    - airlock-dev/airlock

  safe_fix_branches:
    values:
      - 'fix/*'
      - 'feat/*'
    expose_values: true
```

`arg_dimensions` map a reusable name onto concrete tool argument paths. `match`
controls how the value set is converted into runtime argument policy:
`in` creates exact allow-list checks, `glob_in` creates glob-pattern checks, and
`each_in` requires every value in an array argument to be allowed. `normalize`
can be `phone`, `email`, `lower`, or `trim`.

```yaml
arg_dimensions:
  github_repo:
    match: in
    bindings:
      github/push_files: repo
      github/create_pull_request: repo

  github_branch:
    match: glob_in
    bindings:
      github/push_files: branch
      github/create_pull_request: head
```

Profiles and agents attach these dimensions through `arg_scope`:

```yaml
profiles:
  airlock_autofix:
    arg_scope:
      github_repo: airlock_repos
      github_branch: safe_fix_branches
```

At config load, Airlock expands `arg_scope` into concrete `arg_policy`
constraints. Unknown dimensions, unknown value sets, empty dimensions, and
declared argument controls that resolve to no effective runtime constraints are
reported by `airlock config check`.

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
    inherit_default: true # Inherit the top-level default_profile (default: true)
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
      github/push_files:
        branch:
          glob_in: safe_fix_branches
          label: Safe branch

    arg_scope: # Reusable argument constraints via arg_dimensions
      github_repo: airlock_repos

    command_policy: # Route a CLI-dispatcher tool's command arg (allow/ask/deny, deny > ask > allow)
      posthog/exec:
        command:
          allow: ['call query-* *', 'info *', 'search *']
          ask: ['call insight-* *', 'call dashboard-* *']
          deny: ['* --confirm *', 'call switch-* *']
          default: deny # unmatched → deny (fail-closed; the default)

    middleware: # Optional per-agent configurable middleware
      - name: rate-limiter
        max_requests: 100
        window_ms: 60000
        per: agent
      - name: output-size-limiter
        max_lines: 200
        max_chars: 30000

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
      railway/get-logs:
        # Keeps the vendor's own description and adds a house rule after it.
        description_append: 'Always pass projectId explicitly — list-projects will not show it.'
```

`description` **replaces** the upstream description; `description_append` **adds** to whatever
survives. Use `description_append` when the vendor's docs are fine and you only need to add a
caveat, so you do not have to restate their text by hand and keep it in sync.

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

Agent `middleware` is an optional array. If omitted, Airlock enables the default
configurable middleware: `schema-validator`, `untrusted-envelope`, and
`output-injection-detector`. Set `middleware: []` for the bare fixed pipeline,
or include `{ name: <middleware>, enabled: false }` to disable one default. See
[Middleware Pipeline](/concepts/middleware).

## `lint`

Static hygiene rule configuration for `airlock lint`.

```yaml
lint:
  disable:
    - dead-deny
  severity:
    unused-profile: warn
    missing-env-ref: error
```

Use `disable` to permanently accept a rule for a config, and `severity` to
re-grade a rule as `info`, `warn`, or `error`. CLI flags such as
`--disable` and `--rule` override this block for one invocation.

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
and, when `expose_tools_api` enables it, the REST agent tool API
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
  listener (an agent-facing execution API using the same per-agent auth model as
  MCP routes). It is a mode: `all` exposes it for every agent, `none` is a hard
  kill-switch, and `per-agent` (the default) exposes it only for agents that set
  their own `expose_tools_api: true`. Legacy booleans are accepted (`true` →
  `all`, `false` → `none`). **Migration note:** the default changed from
  on-for-all to `per-agent` (off unless an agent opts in) — set `all`, or opt the
  relevant agents in, to keep the previous behavior.
- `management_api.enabled` starts a separate control-plane listener for
  `/health`, `/hitl/*`, `/audit`, the dashboard approval bridge (`/events`,
  `/approve`, `/deny`, `/version*`), `/activity`, `/mobile/*` including
  `/mobile/approvals/stream`, `/admin/tools`, and `/hook`.
  It is disabled by default. When enabled, every agent must set `token` so the
  data-plane fallback cannot become an implicit agent credential.
- `management_api.api_secret` protects the control-plane listener. If unset,
  Airlock temporarily falls back to `server.api_secret` for backward
  compatibility and emits a deprecation warning telling operators to set
  `server.management_api.api_secret` separately. If both secrets resolve to the
  same value, config validation warns so operators can rotate one.
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
