# Dashboard

The dashboard is a browser UI for reviewing approvals, editing agents and
profiles, checking provider status, and reading the audit log. It is a
self-contained HTML app with no build step and no external frontend service.

You can run it in two modes:

- In-process approval provider, useful for local single-process setups.
- Standalone admin dashboard, useful for Docker/VPS deployments where the MCP
  gateway keeps its config read-only and the dashboard mounts config read-write.

## In-process provider

Set the approval provider to `dashboard` in your config:

```yaml
approvals:
  provider:
    type: dashboard
    host: 127.0.0.1 # default
    port: 4112 # default
  timeout_ms: 300000
```

When Airlock starts, the dashboard is available at `http://localhost:4112`.

The dashboard binds to `127.0.0.1` by default. In Docker, set `host: 0.0.0.0`
only when the dashboard port is kept private or protected by an authenticated
reverse proxy.

## Standalone dashboard

Run the gateway and dashboard as separate processes:

```bash
airlock gateway --config /config/airlock.yaml

airlock dashboard \
  --config /config/airlock.yaml \
  --gateway-url http://127.0.0.1:4113
```

The standalone dashboard talks to the gateway management API for status, audit
logs, tool discovery, and approval decisions. Set the dashboard secret with
`--gateway-secret` or `AIRLOCK_GATEWAY_SECRET`. If your gateway config uses a
separate `MANAGEMENT_API_SECRET`, pass that value through explicitly:

```bash
AIRLOCK_GATEWAY_SECRET="$MANAGEMENT_API_SECRET" \
  airlock dashboard \
    --config /config/airlock.yaml \
    --gateway-url http://127.0.0.1:4113
```

Use this mode when the gateway should mount `/config` read-only and the
dashboard should mount the same directory read-write for config edits. The
dashboard writes a backup to `/config/airlock.bak` before saving changes.

The standalone dashboard binds to `127.0.0.1:4177` by default. Use `--port` to
change the port. Binding the dashboard beyond loopback requires
`--insecure-remote-bind`; only use it when the listener is protected by an
authenticated reverse proxy, private network, or tunnel.

## Features

### Provider status

The Providers system tab shows each provider's runtime state, visible tool
count, and any connection error. If any provider is not up, the tab gets a red
issue count badge so missing auth, expired tokens, disabled providers, and
disconnects are visible without opening the provider list.

### Live updates via SSE

The dashboard uses Server-Sent Events to push new approval requests and resolution updates in real time. No polling. Open the page and requests appear instantly as the agent makes them.

### Approval cards

Each pending request is displayed as a card showing:

- Tool name (highlighted)
- Agent name
- Approval code
- Tool arguments (truncated preview)

Click a card to open a detail modal with full argument inspection.

### Fetched approval previews

Configure [`approvals.previews`](/reference/config#approval-previews) to resolve
opaque IDs for the operator. Opening a pending approval's detail view fetches
the configured read and shows its text or structured result immediately at the
top of the review, before the agent's request reason, note, and opaque arguments.
A small provenance line below the content identifies the read and any truncation.
The returned content is shown as plain text; HTML, images, and scripts are not
executed. No lookup runs merely because an agent submits a request.

Previews work in the in-process provider, standalone remote dashboard, and
updated iOS and macOS companions. Companions fetch them through the authenticated
`POST /mobile/approvals/:id/preview` endpoint only when reviewing a pending
approval. Older gateways and approvals without a configured preview show the
existing detail view. Preview failures show an error without blocking decisions.

Preview content is not included in the agent response, queue or history APIs,
SSE events, push messages, or webhook notifications. The original call remains
pending until the operator approves or denies it and runs separately after
approval. Preview failures do not approve or deny the original request.

Reads are coalesced and cached in memory for the pending approval. Resolving
the approval removes access to the preview, including results arriving after
resolution; restart clears the cache. The preview is a snapshot and may differ
from a later read of a mutable resource. The timeout bounds the operator's wait;
it does not guarantee cancellation of a provider's in-flight operation.

The audit log records the preview tool, redacted arguments, outcome, duration,
and approval ID as `request_id`, without the response body or upstream error
text. Existing field redaction applies to structured preview fields. Message
body text is intentionally visible to the operator. Preview content is not
persisted to the approval queue or audit database.

The preview endpoint lives on the management listener, never the agent tool
listener. Use a management secret distinct from agent credentials. The dashboard
itself is an operator surface: its local listener is unauthenticated, just like
its approve/deny routes, so keep it behind your existing operator access boundary.
This separates MCP agent access from operator review; it does not isolate a
same-machine process that can already access the dashboard or management secret.

### Detail modal

The modal shows:

- Agent name
- Approval code
- Timeout remaining
- Full tool arguments with syntax highlighting (via highlight.js)
- Multiline strings are displayed as code blocks
- Objects and arrays are pretty-printed as JSON

### Keyboard shortcuts

- **A** — approve the focused request (or the request in the open modal)
- **D** — deny the focused request

### Browser notifications

Toggle browser notifications in the settings panel. When enabled, you get a system notification for each new approval request — useful when the dashboard tab is in the background.

### Sound alerts

Optional sound alerts for new requests. Toggle in the settings panel. Persisted to localStorage.

### Version check

The dashboard checks npm for newer versions of `airlock-bot` and shows an upgrade banner if one is available. The check is cached for one hour.

## Combining with the macOS Companion

The [macOS Companion app](https://github.com/airlock-dev/airlock/releases/latest) connects directly to the split management API at `http://127.0.0.1:4113` when you set its gateway bearer token to the management API secret. Companion-style clients stream from `/mobile/approvals/stream`, reconcile against `/mobile/approvals`, and post decisions by canonical approval ID. You can use these surfaces simultaneously; resolution events dismiss pending approvals everywhere.

## Graceful degradation

In in-process mode, if port 4112 is already in use, Airlock logs a warning and
continues running without the dashboard UI. The rest of the gateway (MCP
proxying, HITL via other providers, audit logging) is unaffected.

### Structured preview fields

Preview metadata such as sender, recipient, task title, or event time appears as
compact label/value rows. Primary fields such as an email body or targeted message
stay visible below those rows. The companions and web view use the same field
contract; unknown fields do not require frontend integration code.

Configured request fields (for example, a proposed reply) appear separately under
**Requested action**. They are agent-supplied arguments, not fetched facts. Preview
content remains operator-only and is never returned as part of an agent tool call.
Plain-text previews and older gateway/companion versions remain supported.

This rendered web example uses synthetic content. Fetched fields appear before
the requested action and raw arguments, with decisions kept at the bottom:

![Structured approval preview](/images/approval-previews/web-structured.png)

The same flow at a [narrow viewport](/images/approval-previews/web-narrow.png)
keeps decisions visible. A [failed lookup](/images/approval-previews/web-failure.png)
leaves the original approval available for review.
