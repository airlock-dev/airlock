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
  port: 4111
  host: 127.0.0.1
  api_secret: ${AIRLOCK_API_SECRET}
  management_api:
    enabled: true
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

All management endpoints require `server.api_secret` when
`management_api.enabled` is true:

```yaml
server:
  api_secret: ${AIRLOCK_API_SECRET}
```

When the management API is enabled, every agent must also set its own `token`.
Airlock rejects tokenless agents in split mode so the management `api_secret`
cannot double as an agent data-plane credential.

```bash
curl -H "Authorization: Bearer $AIRLOCK_API_SECRET" http://localhost:4113/health
```

```yaml
server:
  management_api:
    enabled: false
```

When `management_api.enabled` is false, `/health`, `/hitl/*`, `/audit`, the
dashboard approval bridge (`/events`, `/approve`, `/deny`, `/version*`),
`/mobile/*`, `/admin/tools`, and `/hook` are not registered on any listener.

Agent-facing REST tool execution is not part of the management API. When
`server.expose_tools_api` is true, `/agents/:agentId/tools` and
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
  "uptime": 3600,
  "pendingApprovals": 2
}
```

`dataPlane` is a live TCP probe of the agent MCP listener. `mcpHealth` reports
the downstream MCP provider pool behind that listener.

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

Approve a pending request by ID.

```bash
curl -X POST http://localhost:4113/hitl/approve/abc123
```

### `POST /hitl/deny/:id`

Deny a pending request by ID. Optionally include a reason:

```bash
curl -X POST http://localhost:4113/hitl/deny/abc123 \
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
curl "http://localhost:4113/audit?agent=claude-code&tool=exec/run&limit=50"
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

Browser `EventSource` cannot set an `Authorization` header directly. In split
mode, run `airlock dashboard` with `--gateway-secret`,
`AIRLOCK_GATEWAY_SECRET`, or `AIRLOCK_API_SECRET`; the dashboard server proxies
the SSE connection to the gateway with the bearer token.

### `POST /approve?code=ABC123`

Approve a pending request by short approval code. This is the endpoint used by
dashboard clients and companion-style approval UIs.

```bash
curl -X POST \
  -H "Authorization: Bearer $AIRLOCK_API_SECRET" \
  "http://localhost:4113/approve?code=ABC123"
```

### `POST /deny?code=ABC123`

Deny a pending request by short approval code.

```bash
curl -X POST \
  -H "Authorization: Bearer $AIRLOCK_API_SECRET" \
  "http://localhost:4113/deny?code=ABC123"
```

## Mobile companion API

The mobile endpoints are exposed with the management API. Registering or
revoking devices requires the gateway admin bearer token. Queue, history, push
token update, and decision calls may use either the admin token or the per-device
token returned during registration.

### `POST /mobile/devices/register`

Register an iOS device for APNs approval notifications.

```bash
curl -X POST http://localhost:4113/mobile/devices/register \
  -H "Authorization: Bearer $AIRLOCK_API_SECRET" \
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

### `PUT /mobile/device`

Update the calling device's APNs token after iOS rotates it.

### `GET /mobile/approvals`

List currently pending approvals in the mobile app shape.

### `GET /mobile/approvals/history?limit=50`

List recently resolved approvals from the persisted HITL queue.

### `POST /mobile/approvals/:id/decision`

Approve or deny a pending approval by id or code.

```bash
curl -X POST http://localhost:4113/mobile/approvals/abc123/decision \
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

### `GET /version`

Returns the running Airlock version.

### `GET /version/latest`

Checks npm for the latest published `airlock-bot` version. Dashboard clients use
this for the upgrade banner.

## Hook API

Airlock can also expose a `/hook` endpoint on the management listener for
non-MCP tools that want policy and approval decisions. See
[Hook Endpoint](/guides/hook-endpoint) for details.
