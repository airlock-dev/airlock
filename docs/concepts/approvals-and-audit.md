# Approvals and Audit

Airlock's safety story is policy plus visibility.

## Approval flow

When an agent calls a tool in its `ask` list:

1. Airlock creates a pending approval request with a unique code
2. The request is persisted to SQLite immediately (crash recovery)
3. The HITL provider sends a notification (Telegram, Slack, dashboard, etc.)
4. The MCP connection stays open — the agent blocks, experiencing a slow tool call
5. You approve or deny (by code or by ID)
6. The tool executes or the agent receives a denial
7. The outcome is logged to the audit trail

No special client support is needed. The agent just sees a tool call that takes longer to respond.

## Approval providers

| Provider        | Config `type` | Best for                                      |
| --------------- | ------------- | --------------------------------------------- |
| stdio           | `stdio`       | Local dev and testing                         |
| TUI             | `tui`         | Terminal-based approval with `j/k` navigation |
| Dashboard       | `dashboard`   | Browser-based approval queue with live SSE    |
| macOS dialog    | `macos`       | Native approve/deny popup on Mac              |
| Telegram        | `telegram`    | Remote approval from your phone               |
| Slack           | `slack`       | Team-visible approvals via webhook            |
| Generic webhook | `webhook`     | Custom integrations                           |
| OpenClaw        | `openclaw`    | WebSocket RPC to OpenClaw gateway             |

See [HITL Providers](/reference/hitl-providers) for config details and the [Dashboard guide](/guides/dashboard) for the web UI.

## What an approval includes

Approval payloads include:

- Agent ID
- Tool name
- Full input arguments
- Approval code (short, human-friendly)
- Timeout duration

For sandboxed tool variants, operators also see:

- Applied preset names
- Allowed network domains (or "none")
- Writable paths
- Denied read paths

## Batched notifications

When an agent makes a burst of `ask` calls, Airlock batches them into a single notification instead of spamming you with one message per call.

```yaml
approvals:
  batch_window_ms: 10000 # Collect requests for 10 seconds
```

Batching is per-agent. Requests arriving within the window are bundled and sent as one message. Each request still gets its own approval code — you can approve or deny them individually, or use `approve all` / `deny all`.

## Timeout and recovery

Approval requests time out after `timeout_ms` (default 300000 — 5 minutes). Timed-out requests are denied automatically and logged.

Pending approvals are persisted to SQLite on creation. If Airlock crashes and restarts, pending requests are recoverable.

## Audit log

Every tool call is recorded to SQLite:

| Field          | Description                                         |
| -------------- | --------------------------------------------------- |
| `agent_id`     | Which agent made the call                           |
| `tool`         | Namespaced tool name (e.g. `github/create_pr`)      |
| `args`         | Serialized arguments                                |
| `result`       | Success, error, denied, timeout, canary_leaked      |
| `duration_ms`  | Wall-clock execution time                           |
| `hitl_outcome` | approved, denied, timeout, or null (no HITL needed) |
| `error`        | Error message if the call failed                    |
| `created_at`   | Timestamp                                           |

For sandboxed tools, the resolved sandbox context is included alongside the recorded args.

## Secret redaction

Sensitive fields are automatically redacted in audit logs. Airlock matches field names case-insensitively against configurable patterns:

```yaml
audit:
  redact_fields:
    - password
    - token
    - secret
    - authorization
    - api_key
```

Matched fields are replaced with `[REDACTED]` in the stored args.

## Management API

Query and manage approvals programmatically:

- `GET /health` — gateway status, pending count, uptime
- `GET /hitl/pending` — list pending approvals
- `POST /hitl/approve/:id` — approve by ID
- `POST /hitl/deny/:id` — deny by ID with optional reason
- `GET /audit?agent=&tool=&since=&limit=` — query the audit log

See [Management API](/reference/management-api) for full details.
