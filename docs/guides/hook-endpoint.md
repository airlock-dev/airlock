# Hook Endpoint

Airlock can expose a `/hook` endpoint on the management API listener for
external tools that want a policy and approval decision without speaking MCP
directly.

## What it does

Non-MCP clients — CI scripts, Claude Code hooks, custom integrations — can POST a tool call description to Airlock and get back the same allow/deny/ask decision that MCP tool calls receive.

## Request format

```bash
curl -X POST http://localhost:4113/hook \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $MANAGEMENT_API_SECRET" \
  -d '{
    "client": "claude-code",
    "tool": "Bash",
    "input": {
      "command": "git push origin main"
    }
  }'
```

### Fields

| Field        | Required | Description                                               |
| ------------ | -------- | --------------------------------------------------------- |
| `client`     | Yes      | Client name (used for agent lookup if `agent` is not set) |
| `agent`      | No       | Explicit agent ID (overrides `client`)                    |
| `tool`       | Yes      | Tool name as the client knows it                          |
| `input`      | No       | Tool arguments (default `{}`)                             |
| `session_id` | No       | Optional session ID for tracking                          |

## Tool name normalization

Different clients call the same tools by different names. Airlock normalizes tool names across clients:

- Claude Code's `Bash` → `bash/<executable>` (`git push …` → `bash/git`); commands using shell
  metacharacters become `bash/_complex`
- Claude Code's `Edit` / `Read` / `Write` → `file/edit` / `file/read` / `file/write`, and
  `WebFetch` → `http/fetch`
- Names are case-sensitive, and unknown tools pass through unchanged

The normalized name is what gets evaluated against the agent's policy.

## Response flow

1. Airlock receives the request
2. The tool name is normalized based on the client
3. Policy is evaluated against the agent's allow/ask/deny lists
4. If **allow**: returns immediately with permission granted
5. If **deny**: returns immediately with permission denied
6. If **ask**: creates a HITL approval request, blocks until approved or denied, then returns the outcome

## Authentication

If `server.management_api.api_secret` is configured, the endpoint requires
`Authorization: Bearer <management secret>`. If it is unset, Airlock falls back
to `server.api_secret` for backward compatibility and emits a deprecation
warning. The comparison uses `timingSafeEqual` — no timing side-channel.

```yaml
server:
  api_secret: ${AIRLOCK_API_SECRET}
  management_api:
    enabled: true
    api_secret: ${MANAGEMENT_API_SECRET}
    expose_hook_api: true
```

## Use cases

### Claude Code hooks

Use Claude Code's hook system to route tool calls through Airlock:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [{ "type": "command", "command": "/path/to/airlock/scripts/claude-code-hook.sh" }]
      }
    ]
  }
}
```

`scripts/claude-code-hook.sh` reads the hook payload, calls `/hook`, and answers in the format
Claude Code expects. Set `AIRLOCK_SECRET` to the management API secret; `AIRLOCK_URL` defaults to
`http://localhost:4113`.

### CI pipeline gates

Check if a deployment or sensitive operation is approved:

```bash
RESULT=$(curl -s -X POST http://localhost:4113/hook \
  -H "Authorization: Bearer $MANAGEMENT_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"client":"ci","agent":"deploy-bot","tool":"deploy/production","input":{"version":"v1.2.3"}}')

if echo "$RESULT" | jq -e '.decision == "allow"' > /dev/null; then
  echo "Approved — deploying"
else
  echo "Denied — aborting"
  exit 1
fi
```

### Custom integrations

Any HTTP client can call the hook endpoint to get Airlock policy decisions without implementing MCP.
