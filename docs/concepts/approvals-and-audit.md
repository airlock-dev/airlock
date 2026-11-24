# Approvals and Audit

Airlock's safety story is policy plus visibility.

## Approval flow

When an agent calls a tool in its `ask` list:

1. Airlock creates a pending approval request with a unique code
2. The request is persisted to SQLite immediately (crash recovery)
3. The approval provider presents or sends a notification (Telegram, dashboard, Slack webhook, etc.)
4. The tool call is held open for up to `sync_wait_ms` (25 seconds by default)
5. If you decide in that time, the tool executes (or the agent receives a denial) as if it were a
   slow tool call
6. If you don't, the agent gets a structured "pending" answer and the request stays live. When you
   approve, Airlock runs the call and keeps the result for the agent
7. The outcome is logged to the audit trail

No special client support is needed: a quick decision looks like a slow tool call, and a slow one
never runs into the client's request timeout. See [Hybrid, sync and async approvals](#hybrid-sync-and-async-approvals).

## Approval providers

| Provider        | Config `type` | Best for                                                       |
| --------------- | ------------- | -------------------------------------------------------------- |
| stdio           | `stdio`       | Local dev and testing                                          |
| TUI             | `tui`         | Terminal-based approval with `j/k` navigation                  |
| Dashboard       | `dashboard`   | Browser-based approval queue with live SSE                     |
| macOS dialog    | `macos`       | Native approve/deny popup on Mac                               |
| iOS companion   | `ios`         | APNs push notifications to the Airlock iOS companion app       |
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

- **Policy still wins.** A grant only applies to calls whose policy decision is `ask`. Calls that
  resolve to `deny` (or default-deny) stay denied; calls that resolve to `allow` never need one.
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

### Hybrid, sync and async approvals

`approvals.mode` (or an agent's `approval_mode`) decides how a gated call waits:

| Mode               | While you decide                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------ |
| `hybrid` (default) | The call is held open for up to `sync_wait_ms` (25s), then the agent is answered "pending" |
| `sync`             | The call is held open until you decide (or `timeout_ms`)                                   |
| `async`            | The agent is answered "pending" at once (the same as `hybrid` with `sync_wait_ms: 0`)      |

```yaml
approvals:
  mode: hybrid # default
  sync_wait_ms: 25000 # how long hybrid holds the call open
  execute_on_approve: true # default
agents:
  long-runner:
    approval_mode: async # per agent; also sync_wait_ms and execute_on_approve
```

While a call is held open, Airlock sends MCP progress notifications every 15s if the client asked
for progress, so clients that reset their timeout on progress keep waiting.

**The "pending" answer is not an error.** It is a normal result (`isError: false`) with a JSON
body (also sent as `structuredContent`). It never contains the approval code, since that is what
you type to approve:

```json
{
  "status": "pending",
  "approval_id": "550e8400-e29b-41d4-a716-446655440000",
  "tool": "gmail_send_email",
  "expires_at": "2026-11-23T20:05:00.000Z",
  "execute_on_approve": true,
  "message": "Waiting for the user to approve gmail_send_email. Nothing has run yet; Airlock runs it automatically once approved, so do not call it again. ..."
}
```

The message tells the agent to carry on with other independent work and call
`airlock_await_approval` when it needs the result, or otherwise to call it once or pause and tell
you it is waiting, rather than polling in a loop.

**A dropped connection is not a "no".** In `hybrid` mode, if the client gives up or the connection
drops during the inline wait, the request spills to "pending" and stays live. Only an explicit MCP
cancellation (`notifications/cancelled`) withdraws it. In `sync` mode any disconnect cancels the
request, as before.

#### Execute on approve

With `execute_on_approve: true` (the default), approving a request the agent was answered
"pending" for **runs the call right away**, through the agent's full pipeline: policy is
re-checked against the live config, then the call executes and its result goes through the
configured response middleware (untrusted envelope, injection detector, size limiter, summarizer)
and the audit log, as an inline call would. It doesn't matter where you approve it: a single
approval, a grant that sweeps pending requests, "approve all" on a batch, the dashboard, a
companion app or a chat channel.

A call answered "pending" that will run on approval keeps the `rate-limiter` slot it was admitted
with, and its approved run is not counted or throttled again.

The result is kept in memory for `approvals.grants.async_ttl_ms` (30 min), size-capped, and
`airlock_await_approval` returns it directly (`status: "completed"` with `result`, or
`status: "failed"` with `error`). The agent never has to repeat the call. If it does repeat the
exact call anyway, it gets that same result back once instead of the tool running twice.

The call's raw arguments live only in memory for this. Nothing unredacted goes to SQLite. If
Airlock restarts before you approve, or `execute_on_approve` is `false`, approval instead leaves a
single-use grant for that exact call, valid for `async_ttl_ms`, and the agent's retry with
identical arguments goes through. Retrying while the request is still pending waits on the same
request instead of creating a second one. Retrying right after a denial gets the denial back
without prompting you again.

#### `airlock_await_approval`

```json
{ "id": "550e…", "wait_seconds": 30 }
{ "ids": ["550e…", "7c1d…"], "wait_for": "all", "wait_seconds": 50 }
```

- `id` or `ids` (up to 50). With `ids` the answer is `{ "wait_for", "done", "approvals": [...] }`.
- `wait_for`: `any` (default) returns as soon as one is decided; `all` waits for every one.
- `wait_seconds`: default 30, max 50 (under typical client timeouts). `0` checks without waiting.

Each approval reports `status`: `pending`, `executing`, `completed` (with `result.text`),
`failed` (with `error`), `approved` (nothing ran: a plan, a question, or a retry-grant call),
`denied`, `timeout` or `cancelled`. An answered question also reports `answer`.

#### `airlock_ask_user`

`airlock_ask_user` follows the same mode. In `hybrid`, if you don't answer within `sync_wait_ms`
the agent gets `{ "status": "pending", "approval_id": … }` and reads your answer later with
`airlock_await_approval`. In `sync` it waits until you answer.

A question is yes/no (approve/deny), or the agent can offer `choices`:

```json
{ "question": "Deploy to which environment?", "choices": ["staging", "production"] }
```

You answer by approving with `answer` set to one of the choices: `POST /hitl/approve/:id` or the
mobile decision endpoint with `{"answer": "staging"}`, or `POST /approve?code=…&answer=staging` on
the dashboard. Approving without an answer still reads as "yes".

#### Waking agents up: `airlock/approval_decided`

Agents on the [MCP Events](/concepts/permissions#mcp-events-sep-3415) protocol era see a built-in
event, `airlock/approval_decided`, as soon as they can hit an approval at all. It fires when one
of the agent's "pending" approvals reaches a final state, so the agent can wait for it instead of
polling `airlock_await_approval`:

```json
{
  "approvalId": "550e…",
  "tool": "gmail_send_email",
  "kind": "call",
  "status": "completed",
  "executed": true,
  "decidedAt": "2026-11-23T20:01:12.000Z"
}
```

It supports `poll` (`events/poll`, with a cursor over a bounded buffer of recent decisions; the
first poll without a cursor returns what is still buffered) and `push` (`events/stream`). It takes
no arguments, needs no `events` rule, and only ever carries the requesting agent's own approvals,
never an approval code. Decisions made while the call was still held open aren't emitted: the
agent already has those results.

The [hook endpoint](/guides/hook-endpoint) follows the mode too, except that it can't run the
call itself (the client does): in `hybrid` and `async` it answers `deny` with a "pending approval,
retry once approved" reason, and the retry succeeds after you approve.

## Timeout and recovery

Approval requests time out after `timeout_ms` (default 300000 — 5 minutes). Timed-out requests are denied automatically and logged.

Pending approvals are persisted to SQLite on creation. If Airlock crashes and restarts, pending requests are recoverable.

## Audit log

Every tool call is recorded to SQLite:

| Field         | Description                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | Row id (integer)                                                                                                                        |
| `ts`          | ISO timestamp                                                                                                                           |
| `agent_id`    | Which agent made the call                                                                                                               |
| `tool`        | Namespaced tool name (e.g. `github/create_pr`)                                                                                          |
| `args`        | Serialized (redacted) arguments                                                                                                         |
| `result`      | `received`, `dispatched`, then a terminal state such as `success`, `error`, `denied`, `hitl_approved`, `hitl_denied`, or `hitl_timeout` |
| `error`       | Error message if the call failed                                                                                                        |
| `duration_ms` | Wall-clock execution time                                                                                                               |
| `hitl_code`   | Approval code when the call went through approval, otherwise null                                                                       |
| `request_id`  | Shared by every row written for the same call                                                                                           |

A single call writes several rows with the same `request_id`. A `request_id` with
`received` or `dispatched` but no terminal row is a call that is still in flight.

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
