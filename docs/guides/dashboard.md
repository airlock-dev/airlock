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
  --gateway-url http://127.0.0.1:4111
```

The standalone dashboard talks to the gateway management API for status, audit
logs, tool discovery, and approval decisions. Set the dashboard secret with
`--gateway-secret`, `AIRLOCK_GATEWAY_SECRET`, or `AIRLOCK_API_SECRET`:

```bash
AIRLOCK_GATEWAY_SECRET="$AIRLOCK_API_SECRET" \
  airlock dashboard \
    --config /config/airlock.yaml \
    --gateway-url http://127.0.0.1:4111
```

Use this mode when the gateway should mount `/config` read-only and the
dashboard should mount the same directory read-write for config edits. The
dashboard writes a backup to `/config/airlock.bak` before saving changes.

The standalone dashboard binds to `127.0.0.1:4177` by default. Use `--host` and
`--port` to change the listener, and protect it with an authenticated reverse
proxy or private network before exposing it.

## Features

### Live updates via SSE

The dashboard uses Server-Sent Events to push new approval requests and resolution updates in real time. No polling. Open the page and requests appear instantly as the agent makes them.

### Approval cards

Each pending request is displayed as a card showing:

- Tool name (highlighted)
- Agent name
- Approval code
- Tool arguments (truncated preview)

Click a card to open a detail modal with full argument inspection.

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

The [macOS Companion app](https://github.com/airlock-dev/airlock/releases/latest) connects to the same dashboard SSE endpoint. You can use both simultaneously — the dashboard in a browser tab and the companion in your menu bar.

## Graceful degradation

In in-process mode, if port 4112 is already in use, Airlock logs a warning and
continues running without the dashboard UI. The rest of the gateway (MCP
proxying, HITL via other providers, audit logging) is unaffected.
