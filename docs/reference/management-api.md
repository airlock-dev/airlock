# Management API

When running in gateway mode (not stdio), Airlock exposes a REST API for health checks, approval management, and audit log queries.

## Authentication

All management endpoints require a bearer token when `server.api_secret` is configured:

```yaml
server:
  api_secret: ${AIRLOCK_API_SECRET}
```

```bash
curl -H "Authorization: Bearer $AIRLOCK_API_SECRET" http://localhost:4111/health
```

If `api_secret` is not set and `server.auth_required` is false, the endpoints are
unauthenticated. For exposed deployments, set `server.auth_required: true` and
either configure `server.api_secret` or disable the management API entirely:

```yaml
server:
  auth_required: true
  expose_management_api: false
```

When `expose_management_api` is false, `/health`, `/hitl/*`, `/audit`, the
dashboard approval bridge (`/events`, `/approve`, `/deny`, `/version*`), and
`/admin/tools` are not registered.

## Endpoints

### `GET /health`

Returns gateway health status, pending HITL count, and uptime.

```json
{
  "status": "ok",
  "uptime": 3600,
  "pending_hitl": 2,
  "version": "0.2.27"
}
```

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
curl -X POST http://localhost:4111/hitl/approve/abc123
```

### `POST /hitl/deny/:id`

Deny a pending request by ID. Optionally include a reason:

```bash
curl -X POST http://localhost:4111/hitl/deny/abc123 \
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
curl "http://localhost:4111/audit?agent=claude-code&tool=exec/run&limit=50"
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
  "http://localhost:4111/approve?code=ABC123"
```

### `POST /deny?code=ABC123`

Deny a pending request by short approval code.

```bash
curl -X POST \
  -H "Authorization: Bearer $AIRLOCK_API_SECRET" \
  "http://localhost:4111/deny?code=ABC123"
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

Airlock also exposes a `/hook` endpoint for non-MCP tools that want policy and approval decisions. See [Hook Endpoint](/guides/hook-endpoint) for details.
