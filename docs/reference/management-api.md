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

If `api_secret` is not set, the endpoints are unauthenticated.

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

## Hook API

Airlock also exposes a `/hook` endpoint for non-MCP tools that want policy and approval decisions. See [Hook Endpoint](/guides/hook-endpoint) for details.
