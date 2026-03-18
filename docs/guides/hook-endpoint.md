# Hook Endpoint

Airlock exposes a `/hook` endpoint for external tools that want a policy and approval decision without speaking MCP directly.

## What it does

Clients send:

- a client name
- a tool name
- input args
- optionally an explicit agent id

Airlock normalizes that tool name, evaluates policy, and returns `allow`, `deny`, or an approval-backed result after HITL completes.

## Security

If configured, the endpoint requires `Authorization: Bearer <secret>`.
