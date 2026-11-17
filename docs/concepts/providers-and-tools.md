# Providers and Tools

Airlock talks about `providers`, not `mcps`.

A provider is any upstream tool source Airlock can expose to agents.

## Provider types

### MCP servers

Standard MCP servers connected over three transport types:

- **stdio** — Airlock spawns the server as a child process and communicates over stdin/stdout. Best for local tools.
- **SSE** — connects to a remote MCP server's Server-Sent Events endpoint.
- **streamable HTTP** — connects to a remote MCP server using the newer streamable HTTP transport, with optional OAuth support.

```yaml
providers:
  filesystem:
    type: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace']

  remote-tools:
    type: sse
    url: https://tools.example.com/sse
    headers:
      Authorization: 'Bearer ${TOOLS_TOKEN}'

  cloud-mcp:
    type: http
    url: https://mcp.example.com
    oauth: true
    oauth_callback_port: 9876
```

### Built-in providers

Airlock ships with these built-in providers:

- **exec** — shell command execution via `exec/run`, with per-agent command policies
- **http** — HTTP requests via `http/get`, `http/post`, `http/put`, `http/delete`, `http/patch`, `http/head`, with domain allowlists and blocked host enforcement
- **airlock** — notification, human prompt, approval, and agent-visible status tools:
  `airlock/ask_user`, `airlock/notify_user`, `airlock/log`,
  `airlock/status`, `airlock/list_provider_tools`, `airlock/request_approval`
  and `airlock/await_approval`

```yaml
providers:
  exec: builtin
  http: builtin
  airlock: builtin
```

The human-attention `airlock` tools must be either allowed or denied. Airlock
rejects configs that route `airlock/ask_user`, `airlock/notify_user`, or
`airlock/log` through `ask`, because those tools are themselves notification
and approval surfaces.
`airlock/request_approval` (approve several calls up front) and
`airlock/await_approval` (wait for an [async approval](/concepts/approvals-and-audit#async-approvals))
are available to every agent with at least one `ask` rule, unless you deny them. They only create
or read approvals, so they don't need an explicit allow. The `airlock` provider is on by default
for that reason. Set `airlock: { type: builtin, enabled: false }` to remove it.

`airlock/status` and `airlock/list_provider_tools` are permission-aware:
they only show providers and tools visible to the current agent, group tools by
`allow` and `ask`, and omit denied tools.

For safe Python or other scripting workflows, expose `exec/run` aliases such as
`python/sandboxed` with sandbox presets. See [Sandbox Presets and
Variants](/concepts/sandboxing).

### CLI tools

CLI commands exposed as named MCP tools with structured parameters. Generated via [discovery](/guides/cli-discovery) or written by hand.

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
```

### REST APIs

OpenAPI endpoints exposed as MCP tools. Generated via [API discovery](/guides/api-discovery).

```yaml
apis:
  petstore:
    spec: ./petstore.json
    base_url: https://petstore.example.com/v1
    auth:
      type: bearer
      token: ${PETSTORE_TOKEN}
```

## CLI tools vs `exec/run`

Use `exec/run` when you want general shell access with pattern-based command policy.

Use discovered or hand-written `clis` configs when you want named MCP tools with structured parameters. Named CLI tools are discoverable in the agent's tool list with descriptions, so the agent knows what's available without guessing command syntax.

## Connection pool

Airlock manages MCP server connections through a connection pool:

- **Auto-reconnect** — if an MCP server connection drops, Airlock retries in the background. The rest of the gateway keeps running.
- **Health checks** — periodic health checks detect MCP servers that are `up`, `connecting`, `down`, or `auth_required`.
- **Lazy connection** — in stdio mode (`--agent`), Airlock only connects to MCP servers the agent actually references in its allow or ask lists. Unused providers stay disconnected.
- **Parallel initialization** — all MCP servers connect concurrently at startup.

## MCP Apps (inline UI)

Upstream MCP servers that implement [MCP Apps](https://modelcontextprotocol.io/docs/extensions/apps) (`io.modelcontextprotocol/ui`) attach an HTML view to a tool through `_meta.ui.resourceUri`. Hosts that support MCP Apps render that view inline. Airlock proxies these views:

- **Capability** — Airlock tells upstream servers it supports MCP Apps, so they register their UI tools.
- **Namespacing** — Airlock rewrites each `ui://…` view URI to `ui://airlock/<provider>/…`. Two providers can then ship the same URI without colliding, and `resources/read` goes to the right one.
- **Policy** — Airlock serves a view only if a tool the agent can see references it. A denied tool's view reads as not found, and so does any other upstream resource.
- **App-only tools** — Airlock passes `visibility: ["app"]` tools through so the host can keep them away from the model. When the host has said it does not render MCP Apps, Airlock hides those tools itself.
- **Results** — For tools with a view, Airlock keeps `structuredContent` and `_meta` even when a middleware such as `untrusted-envelope` rewrites the text, because the view renders from them. Middlewares still scan that data, but the rewrite only changes the text. Other tools behave as before.

::: warning A button in a view is not an approval
A view's tool calls reach Airlock as ordinary `tools/call` requests over the agent's own connection. Airlock cannot tell them apart from the model's calls, and neither can the upstream server. Every call goes through the same allow / ask / deny policy, whoever made it. If an action needs a human, such as "confirm booking", put the tool under `ask`. The approval then happens out of band in a companion app or the dashboard, not through a "confirm" button the agent could press itself.
:::

## OAuth support

For MCP servers that require browser-based OAuth authentication, the `http` transport type supports:

- Automatic OAuth flows with configurable callback port
- HTTPS relay for OAuth callbacks (for remote or tunneled setups)
- Pre-registered client credentials (`client_id` and `client_secret`)

```yaml
providers:
  authenticated-mcp:
    type: http
    url: https://mcp.example.com
    oauth: true
    client_id: ${MCP_CLIENT_ID}
    client_secret: ${MCP_CLIENT_SECRET}
    oauth_callback_port: 9876
    oauth_callback_url: https://relay.example.com/callback
```

## Security defaults

The built-in HTTP tools enforce security by default:

- **Blocked hosts** — localhost (`127.0.0.1`, `::1`, `localhost`) and RFC-1918 private ranges (`10.*`, `192.168.*`, `172.16.*`) are blocked. This prevents agents from reaching internal services, the Airlock management API, or cloud metadata endpoints.
- **DNS verification** — domain names are resolved before outbound HTTP/OpenAPI requests. If any resolved address is blocked, or if Airlock cannot verify DNS, the request fails closed.
- **Domain allowlists** — per-agent HTTP domain restrictions further limit which hosts the agent can reach.
- **Override** — specific local addresses can be unblocked via the `allowed_local` security config if needed.

This static DNS check does not fully prevent DNS rebinding: the current fetch layer can re-resolve the hostname when it opens the connection. Closing that advanced gap requires a pinned-resolution HTTP transport that connects to the verified IP while preserving the original hostname for Host, SNI, and certificate validation.

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
    - 'host.docker.internal' # Explicitly allow if needed
```
