# Approvals and Audit

Airlock's safety story is policy plus visibility.

## Approval flow

When an agent calls a tool in its `ask` list:

1. Airlock creates a pending approval request with a unique code
2. The request is persisted to SQLite immediately (crash recovery)
3. The approval provider presents or sends a notification (Telegram, dashboard, Slack webhook, etc.)
4. The MCP connection stays open — the agent blocks, experiencing a slow tool call
5. You approve or deny (by code or by ID)
6. The tool executes or the agent receives a denial
7. The outcome is logged to the audit trail

No special client support is needed. The agent just sees a tool call that takes longer to respond.
If your client times out long tool calls, use [async mode](#async-approvals).

## Approval providers

| Provider        | Config `type` | Best for                                                       |
| --------------- | ------------- | -------------------------------------------------------------- |
| stdio           | `stdio`       | Local dev and testing                                          |
| TUI             | `tui`         | Terminal-based approval with `j/k` navigation                  |
| Dashboard       | `dashboard`   | Browser-based approval queue with live SSE                     |
| macOS dialog    | `macos`       | Native approve/deny popup on Mac                               |
| Telegram        | `telegram`    | Remote approval from your phone                                |
| Slack           | `slack`       | Team-visible webhook notifications; pair with a decision route |
| Generic webhook | `webhook`     | Custom integrations                                            |
| OpenClaw        | `openclaw`    | WebSocket RPC to OpenClaw gateway                              |

See [HITL Providers](/reference/hitl-providers) for config details and the [Dashboard guide](/guides/dashboard) for the web UI.

## What an approval includes

Approval payloads include:

- Agent ID
- Tool name
- Full input arguments
- Approval code (short, human-friendly)
- Timeout duration

The web, iOS, and macOS detail views can also fetch operator-only context through explicitly
configured [approval previews](/reference/config#approval-previews). Fetched
content is separate from agent-supplied reasons and notes and is not returned
to the requesting agent or included in notifications.

For sandboxed tool variants, operators also see:

- Applied preset names
- Allowed network domains (or "none")
- Writable paths
- Denied read paths

## Reducing approval fatigue

Approving one call at a time does not scale. If an agent wants to read 10 emails, you should
make one decision, not 10. Airlock has four tools for this. You can use any of them together.

### Grants: approve once, allow similar calls for a while

When you approve a request, you can widen the approval into a **grant**: a time-limited
allowance that also covers similar calls from the same agent. A grant can cover:

| Scope      | Covers                                                             | Example                             |
| ---------- | ------------------------------------------------------------------ | ----------------------------------- |
| `tool`     | Any call to this one tool                                          | `gmail/read_email` for 15 minutes   |
| `tier`     | Tools at or below a safety tier, by default from the same provider | Read-only `gmail` tools for 1 hour  |
| `provider` | Every tool from the provider                                       | All `github` tools for 30 minutes   |
| `profile`  | Every tool a [profile](/guides/profiles) lists under `allow`/`ask` | Everything in `email-reader` for 1h |

A new grant also resolves any **pending** requests it covers. If the agent fired off 9 email
reads in parallel, approving one of them with "allow `gmail/read_email` for 15m" clears the other 8.

Grants are deliberately limited:

- **Policy still wins.** A grant only applies to calls that would otherwise ask. Denied tools stay
  denied. The order is deny > grant > ask > allow > default-deny.
- **Time-boxed.** Grants default to `approvals.grants.default_duration_ms` (15 min) and can never
  last longer than `max_duration_ms` (24h). Permanent allows belong in config. You can also cap a
  grant by number of uses.
- **Never for flagged calls.** If a detector, command policy or exec policy escalated a call
  (for example, the injection detector fired), no broad grant covers it. You also can't widen it
  into a grant. Approve-all skips it too.
- **Optionally session-bound.** A grant can be limited to the MCP session that asked.
- **Revocable.** Grants survive restarts (they're stored in SQLite) and can be listed and revoked
  at any time.

How you create a grant depends on the channel:

- **Chat channels** (Telegram, OpenClaw, stdio): `approve ABC123 15m`, or `approve ABC123 1h reads`.
  Valid scope words are `tool`, `reads`, `writes` and `provider`.
- **iOS / macOS companions and the dashboard:** "Approve & allow…" on the request.
- **macOS dialog provider:** the "Allow 15m" button.
- **TUI:** the `t` key.
- **API:** pass `grant` when approving, or create one up front with `POST /hitl/grants`.

#### Safety tiers

Tier grants use each tool's MCP annotations:

- `readOnlyHint: true` → `read`
- `destructiveHint: false` → `write`
- anything else → `destructive`

Tier grants never cover `destructive` tools. Annotations come from the upstream server, so set the
tier yourself when you don't trust them or a server doesn't provide them:

```yaml
agents:
  assistant:
    tool_overrides:
      gmail/send_email:
        tier: destructive
      notes/search:
        tier: read
```

### Plans: the agent asks for everything up front

Agents with at least one `ask` rule automatically get `airlock_request_approval`. When an agent
already knows it needs several gated calls, it lists them:

```json
{
  "reason": "Summarize this week's invoices",
  "calls": [
    { "tool": "gmail_read_email", "arguments": { "id": "18c1" } },
    { "tool": "gmail_read_email", "arguments": { "id": "18c2" } }
  ]
}
```

You get **one** approval showing every call. Once you approve, each listed call can run once,
with exactly those arguments, within `approvals.grants.plan_ttl_ms` (30 min). The agent then makes
the calls as usual and they go straight through. Any call that doesn't match the plan exactly
goes through normal approval. Calls in the list that are already `allow` are reported back as not
needing approval.

### Burst batching: approve all

Some agents issue several tool calls in parallel. Requests from one agent that arrive within
`batch_window_ms` (default 250ms) are sent as one notification with an "approve all / deny all"
option:

- **Chat channels:** `approve all K7Q2XZ8M` (the batch code is in the message header).
- **iOS:** one push per batch with Approve all / Deny all actions.
- **macOS dialog:** one dialog per batch.
- **TUI:** `A`.
- **Companions:** an "Approve all" button on the group.

"Approve all" only covers the requests you were shown, never ones that arrived later. Flagged
requests are always skipped. Each request still has its own code if you want to decide them
one by one.

```yaml
approvals:
  batch_window_ms: 2000 # wait up to 2s to group parallel calls (0 disables batching)
```

Batching only helps with **parallel** calls. An agent that calls tools one after another can't
send call #2 until call #1 is decided. For sequential work, grants and plans are what reduce the
number of prompts.

### Async approvals

By default (`mode: sync`), a gated call is held open until you decide. Many MCP clients give up
on a tool call after a minute or so. In async mode, Airlock answers straight away:

> Approval pending: Airlock asked the user to approve gmail/send_email (approval id …, code K7Q2XZ8M).
> Nothing was executed. Call airlock_await_approval with {"id": "…"} to wait for the decision,
> then retry this exact call with identical arguments once approved.

When you approve, Airlock creates a single-use grant for that exact call, valid for
`approvals.grants.async_ttl_ms` (30 min). The agent's retry goes through even if it reconnected
in between. Retrying while the request is still pending doesn't create a second request. Retrying
right after a denial gets the denial back without prompting you again.

`airlock_await_approval` waits up to ~50 seconds per call, which keeps it under client timeouts.

```yaml
approvals:
  mode: async # default for all agents
agents:
  long-runner:
    approval_mode: async # or per agent
```

In sync mode, Airlock also sends MCP progress notifications every 15s while a call waits, if the
client asked for progress. Clients that reset their timeout on progress then keep waiting.

The [hook endpoint](/guides/hook-endpoint) supports async mode too. It answers `deny` with a
"pending approval, retry once approved" reason, and the retry succeeds after you approve.

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
- `POST /hitl/approve/:id` — approve by canonical approval ID; optional body `{ "grant": { "scope": "tool", "duration_ms": 900000 } }`
- `POST /hitl/deny/:id` — deny by canonical approval ID with optional reason
- `POST /hitl/approvals/decisions` — decide an explicit list: `{ "ids": [...], "decision": "approved" }`
- `POST /hitl/batches/:batch/decision` — decide a notification batch by id or batch code
- `GET /hitl/grants`, `POST /hitl/grants`, `DELETE /hitl/grants/:id` — list, pre-create and revoke grants
- `GET /audit?agent=&tool=&since=&limit=` — query the audit log
- `GET /events` — dashboard approval event stream
- `POST /approve?code=ABC123` — approve by manual-entry approval code
- `POST /deny?code=ABC123` — deny by manual-entry approval code

See [Management API](/reference/management-api) for full details.
