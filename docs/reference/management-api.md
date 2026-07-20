# Management API

When running in gateway mode (not stdio), Airlock can expose a separate
control-plane REST API for health checks, approval management, hook decisions,
admin tool catalog access, and audit log queries. This listener is distinct
from the agent data-plane listener.

## Configuration

The management API is disabled by default. When enabled, it binds to loopback on
port `4113` unless configured otherwise:

```yaml
server:
  api_secret: ${AIRLOCK_API_SECRET}
  management_api:
    enabled: true
    api_secret: ${MANAGEMENT_API_SECRET}
    host: 127.0.0.1
    port: 4113
    insecure_remote_bind: false
```

The management API port must not equal `server.port`; Airlock refuses to start
if the control-plane and agent data-plane would share a socket. Binding the
management API to a non-loopback address also refuses to start unless
`management_api.insecure_remote_bind: true` is set. Only use that opt-in behind
trusted network controls such as private interfaces, VPN-only routes, or a
reverse proxy route that excludes the agent-reachable path.

`server.expose_management_api` is deprecated. For one release it maps to
`server.management_api.enabled` and emits a warning.

## Authentication

All management endpoints require a bearer token when `management_api.enabled`
is true. Prefer a dedicated control-plane secret:

```yaml
server:
  api_secret: ${AIRLOCK_API_SECRET}
  management_api:
    enabled: true
    api_secret: ${MANAGEMENT_API_SECRET}
```

`server.management_api.api_secret` protects the control-plane listener:
`/health`, `/hitl/*`, `/audit`, the dashboard approval bridge (`/events`,
`/approve`, `/deny`, `/version*`), `/activity`, `/mobile/*`, `/admin/tools`,
and `/hook`.
`server.api_secret` remains the data-plane fallback for tokenless agents on MCP
and REST tools routes. When the management API is enabled, every agent must also
set its own `token`; Airlock rejects tokenless agents in split mode so the
data-plane fallback cannot become an implicit agent credential.

For backward compatibility, if `server.management_api.api_secret` is unset,
the management API falls back to `server.api_secret` and emits a deprecation
warning during config validation. This keeps existing single-secret deployments
working while nudging operators to split and rotate the control-plane secret.
If both fields resolve to the same value, config validation warns because the
two planes are still sharing one credential.

```bash
curl -H "Authorization: Bearer $MANAGEMENT_API_SECRET" http://localhost:4113/health
```

To migrate an existing deployment, generate a fresh `MANAGEMENT_API_SECRET`,
set `server.management_api.api_secret: ${MANAGEMENT_API_SECRET}`, recreate or
restart Airlock, and update companion apps or dashboards to send
`Authorization: Bearer $MANAGEMENT_API_SECRET`. Leave `server.api_secret` in
place only as the data-plane fallback, or remove it entirely when all agents
have per-agent tokens and no tokenless fallback is needed.

Per-device or per-client companion tokens are a follow-up hardening step. They
would let operators revoke one companion without rotating the shared management
secret, but that is separate from this shared control-plane secret split.

```yaml
server:
  management_api:
    enabled: false
```

When `management_api.enabled` is false, `/health`, `/hitl/*`, `/audit`, the
dashboard approval bridge (`/events`, `/approve`, `/deny`, `/version*`),
`/activity`, `/mobile/*`, `/admin/tools`, and `/hook` are not registered on any
listener.

Agent-facing REST tool execution is not part of the management API. When
`server.expose_tools_api` enables it (mode `all`, or `per-agent` with the agent
opted in via `expose_tools_api: true`), `/agents/:agentId/tools` and
`/agents/:agentId/tools/invoke` are served by the data-plane listener alongside
the MCP transports and use agent-scoped authentication.

## Endpoints

### `GET /health`

Returns gateway health status, pending HITL count, and uptime.

```json
{
  "status": "ok",
  "dataPlane": {
    "status": "ok",
    "host": "127.0.0.1",
    "port": 4111
  },
  "mcpHealth": {
    "github": "ok"
  },
  "credentialHealth": {
    "github": {
      "status": "ok",
      "source": "probe",
      "checkedAt": "2026-04-01T12:00:00.000Z"
    }
  },
  "uptime": 3600,
  "pendingApprovals": 2
}
```

`dataPlane` is a live TCP probe of the agent MCP listener. `mcpHealth` reports
the downstream MCP provider pool behind that listener.

`credentialHealth` answers a different question: not "is this provider
reachable?" but "does its credential still work?" The two are independent — a
provider whose OAuth refresh token has died keeps serving MCP happily, so
`mcpHealth` stays `ok` while every real call fails. One entry per pooled
provider:

| Field       | Meaning                                                                             |
| ----------- | ----------------------------------------------------------------------------------- |
| `status`    | `ok`, `auth_required`, `error`, or `unknown`                                        |
| `source`    | `connection` (the transport's own OAuth state), `probe` (an actual call), or `none` |
| `reason`    | Short explanation; omitted on a clean `ok`                                          |
| `checkedAt` | ISO timestamp of the last completed probe; only when `source` is `probe`            |

Providers Airlock authenticates itself (`oauth: true`) report through the
transport and need no configuration. Everything else stays `unknown` until you
give it a [`credential_probe`](./config.md#credential-probe) — a green that
hasn't been earned is worse than an honest `unknown`.

Probes are cached per provider and refreshed lazily on read, so polling
`/health` on a short interval costs at most one real call per `interval_ms` and
never blocks on one. Alert on `auth_required`; treat `unknown` as "not yet
answered", not as a failure.

### `GET /hitl/pending`

Lists all pending approval requests.

```json
[
  {
    "id": "abc123",
    "code": "A1B2C3",
    "agent_id": "claude-code",
    "tool": "exec/run",
    "args": { "command": "git push origin main" },
    "status": "pending",
    "created_at": "2026-04-01T12:00:00Z"
  }
]
```

### `POST /hitl/approve/:id`

Approve a pending request by canonical approval ID. Short approval codes are not
accepted on this programmatic endpoint.

```bash
curl -X POST http://localhost:4113/hitl/approve/550e8400-e29b-41d4-a716-446655440000 \
  -H "Authorization: Bearer $MANAGEMENT_API_SECRET"
```

### `POST /hitl/deny/:id`

Deny a pending request by canonical approval ID. Short approval codes are not
accepted on this programmatic endpoint. Optionally include a reason:

```bash
curl -X POST http://localhost:4113/hitl/deny/550e8400-e29b-41d4-a716-446655440000 \
  -H "Authorization: Bearer $MANAGEMENT_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Not authorized for production pushes"}'
```

### `GET /audit`

Query the audit log. All parameters are optional:

| Parameter | Description                                       |
| --------- | ------------------------------------------------- |
| `agent`   | Filter by agent ID                                |
| `tool`    | Filter by tool name                               |
| `since`   | ISO 8601 timestamp — only entries after this time |
| `limit`   | Maximum number of entries to return               |

```bash
curl -H "Authorization: Bearer $MANAGEMENT_API_SECRET" \
  "http://localhost:4113/audit?agent=claude-code&tool=exec/run&limit=50"
```

Returns an array of audit entries:

```json
[
  {
    "id": "xyz789",
    "agent_id": "claude-code",
    "tool": "exec/run",
    "args": "{\"command\":\"git status\"}",
    "result": "success",
    "duration_ms": 142,
    "hitl_outcome": null,
    "created_at": "2026-04-01T12:01:00Z"
  }
]
```

### `GET /events`

Streams approval events for dashboard-style clients with Server-Sent Events.
This endpoint is used by the in-process dashboard, standalone dashboard, and
macOS Companion app.

The stream replays currently pending approvals when a client connects, then
sends live `new`, `resolved`, and `activity` messages. Resolution events are
emitted no matter which surface resolves the approval, including dashboard,
mobile, companion, timeout, or cancellation paths.

Browser `EventSource` cannot set an `Authorization` header directly. In split
mode, run `airlock dashboard` with `--gateway-secret` or
`AIRLOCK_GATEWAY_SECRET`; the dashboard server proxies the SSE connection to the
gateway with the bearer token. If your gateway config uses
`MANAGEMENT_API_SECRET`, pass that value to the dashboard explicitly.

Dashboard and companion clients should treat the persisted approval ID as the
canonical identity. The short approval code is display/manual-entry sugar.

### `POST /approve?code=ABC123`

Approve a pending request by short approval code. This manual-entry endpoint is
used by dashboard-style browser flows. App clients should post decisions by
canonical approval ID instead.

```bash
curl -X POST \
  -H "Authorization: Bearer $MANAGEMENT_API_SECRET" \
  "http://localhost:4113/approve?code=ABC123"
```

### `POST /deny?code=ABC123`

Deny a pending request by short approval code. App clients should post decisions
by canonical approval ID instead.

```bash
curl -X POST \
  -H "Authorization: Bearer $MANAGEMENT_API_SECRET" \
  "http://localhost:4113/deny?code=ABC123"
```

## Mobile companion API

The mobile endpoints are exposed with the management API. Registering or
revoking devices requires the management bearer token. Queue, history, push
token update, and decision calls may use either the management token or the
per-device token returned during registration.

### `POST /mobile/devices/register`

Register an iOS device for APNs approval notifications.

```bash
curl -X POST http://localhost:4113/mobile/devices/register \
  -H "Authorization: Bearer $MANAGEMENT_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"name":"Charles iPhone","platform":"ios","pushToken":"<apns-device-token>"}'
```

Returns the device id and a one-time-visible device bearer token:

```json
{
  "id": "device-id",
  "name": "Charles iPhone",
  "platform": "ios",
  "token": "airlock_mobile_..."
}
```

### `GET /mobile/devices`

List active registered mobile devices. Requires the admin bearer token.

### `DELETE /mobile/devices/:id`

Revoke a registered mobile device. Requires the admin bearer token.

### `DELETE /mobile/device`

Revoke the calling mobile device. Requires that device's bearer token, or the
admin bearer token.

### `PUT /mobile/device`

Update the calling device's APNs token after iOS rotates it.

### `GET /mobile/approvals`

List currently pending approvals in the mobile app shape.

### `GET /mobile/approvals/stream`

Streams the same approval lifecycle as `/events`, under the mobile namespace
and with mobile authentication. The endpoint accepts either the management
bearer token or a registered device token. It replays pending approvals on
connect, sends live `new`, `resolved`, and `activity` messages, and keeps the
connection alive with SSE comments.

```bash
curl -N http://localhost:4113/mobile/approvals/stream \
  -H "Authorization: Bearer $AIRLOCK_MOBILE_DEVICE_TOKEN" \
  -H "Accept: text/event-stream"
```

### `GET /mobile/approvals/history?limit=50`

List recently resolved approvals from the persisted HITL queue.

### `GET /mobile/activity`

List recent activity events in the mobile app shape.

### `POST /mobile/approvals/:id/decision`

Approve or deny a pending approval by canonical approval ID. Short approval
codes are not accepted here.

```bash
curl -X POST http://localhost:4113/mobile/approvals/550e8400-e29b-41d4-a716-446655440000/decision \
  -H "Authorization: Bearer $AIRLOCK_MOBILE_DEVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"decision":"approved","remember":"temporary","duration_ms":3600000}'
```

### `GET /admin/tools`

Returns the full gateway tool catalog for the dashboard. This is an admin view,
not the filtered tool list an agent receives.

```json
{
  "tools": [],
  "errors": []
}
```

### `GET /activity`

Returns recent activity events for dashboard-style clients.

### `GET /version`

Returns the running Airlock version.

### `GET /version/latest`

Checks npm for the latest published `airlock-bot` version. Dashboard clients use
this for the upgrade banner.

## Hook API

Airlock can also expose a `/hook` endpoint on the management listener for
non-MCP tools that want policy and approval decisions. See
[Hook Endpoint](/guides/hook-endpoint) for details.
