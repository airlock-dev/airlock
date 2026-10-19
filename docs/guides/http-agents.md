# Connecting HTTP Agents

Agents that reach Airlock over the network connect to the streamable HTTP endpoint:

```
http://<gateway-host>:4111/agents/<agent>/mcp
```

## The endpoint is stateless

Airlock serves MCP protocol revision **2026-07-28**, which has no sessions: each request carries its
own protocol version and client info, and any request can be answered by a fresh server instance.
Clients that still speak the 2025 revisions (an `initialize` handshake) are served too, also
without sessions — Airlock never issues an `Mcp-Session-Id`, and `GET`/`DELETE` on the endpoint
answer `405`.

What this means in practice:

- **No session cap.** There is no per-agent limit on connected clients and nothing to reap. Many
  agents, subagents and restarts on one profile never hit "session cap reached".
- **Restarts are invisible to clients.** A client that cached a session id from an older gateway
  keeps working; the stale id is ignored instead of answered with `404`.
- **Execution is still bounded.** `security.limits.max_concurrent_calls_per_agent` (default 8) caps
  tool calls _executing_ at the same time for one agent. Calls parked on approval don't count.
- **Disconnects still cancel approvals.** If a client drops a request that is waiting on human
  approval, the pending approval is cancelled.

The deprecated SSE endpoint (`/agents/<agent>/sse`) still holds sessions and keeps the session
limits in `security.limits`.

## Identify each agent with a session id

Several agents often share one profile — two Claude Code windows, a Codex run and its subagents.
To keep their approvals apart, each one can send a **session id**. Airlock uses it to scope
"allow for this session only" grants: approving `github/*` for an hour for one agent doesn't
approve it for every other agent on the same profile.

Airlock reads the session id from, in order:

1. `_meta["dev.airlock/session"]` on the request (for agents you write yourself)
2. the `X-Airlock-Session-Id` header
3. a `?session=` query parameter on the endpoint URL

Ids are 1–128 characters of `A-Z a-z 0-9 . _ : @ -`; anything else is ignored. The header is the
same one the [HTTP tools API](/guides/openclaw) uses, so a grant made over either covers the same
agent session.

Without a session id, a call can still be approved, and grants can cover the whole profile for a
limited time — but a session-only grant is refused rather than silently widened to every agent on
the profile.

The examples below take the id from an `AIRLOCK_SESSION_ID` environment variable, so each run can
pass its own (for example `AIRLOCK_SESSION_ID=$(uuidgen) codex`).

### Claude Code

`.mcp.json` expands `${VAR}` in `url` and `headers`:

```json
{
  "mcpServers": {
    "airlock": {
      "type": "http",
      "url": "https://gateway.example/agents/claude-code/mcp",
      "headers": {
        "Authorization": "Bearer ${AIRLOCK_TOKEN}",
        "X-Airlock-Session-Id": "${AIRLOCK_SESSION_ID}"
      }
    }
  }
}
```

If the variable is unset Claude Code sends the literal `${AIRLOCK_SESSION_ID}`. Airlock ignores it
(it isn't a valid id), so the agent simply has no session.

### Codex

In `~/.codex/config.toml`, `env_http_headers` maps a header name to the **name** of an environment
variable:

```toml
[mcp_servers.airlock]
url = "https://gateway.example/agents/codex/mcp"
bearer_token_env_var = "AIRLOCK_TOKEN"
env_http_headers = { "X-Airlock-Session-Id" = "AIRLOCK_SESSION_ID" }
```

### Hermes Agent

In `~/.hermes/config.yaml`, `${VAR}` is expanded in `url` and `headers`:

```yaml
mcp_servers:
  airlock:
    url: 'https://gateway.example/agents/hermes/mcp'
    headers:
      Authorization: 'Bearer ${AIRLOCK_TOKEN}'
      X-Airlock-Session-Id: '${AIRLOCK_SESSION_ID}'
```

Hermes resolves variables from `~/.hermes/.env` before the process environment.

### Clients that can't set headers

Put the id in the URL instead:

```
https://gateway.example/agents/my-agent/mcp?session=laptop-1
```

## stdio mode

With `airlock --agent <name>` over stdio, each process is one session automatically; no
configuration is needed.
