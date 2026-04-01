# Dashboard

The dashboard is a localhost web UI for reviewing and acting on approval requests. It runs as a self-contained HTML page served directly from the Airlock process — no build step, no external dependencies.

## Setup

Set the approval provider to `dashboard` in your config:

```yaml
approvals:
  provider:
    type: dashboard
    port: 4112 # default
  timeout_ms: 300000
```

When Airlock starts, the dashboard is available at `http://localhost:4112`.

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

The [macOS Companion app](/companion) connects to the same dashboard SSE endpoint. You can use both simultaneously — the dashboard in a browser tab and the companion in your menu bar.

## Graceful degradation

If port 4112 is already in use, Airlock logs a warning and continues running without the dashboard UI. The rest of the gateway (MCP proxying, HITL via other providers, audit logging) is unaffected.
