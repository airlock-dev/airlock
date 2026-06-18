# HITL Providers

Airlock supports several approval backends. Configure one in the `approvals.provider` block.

## stdio

Prints approval requests to stderr and reads responses from stdin. Simplest option for local dev and testing.

```yaml
approvals:
  provider:
    type: stdio
  timeout_ms: 300000
```

## TUI

Terminal UI rendered on stderr via `/dev/tty`. Navigate with `j/k`, approve with `a`, deny with `d`. Supports multiple pending requests simultaneously.

```yaml
approvals:
  provider:
    type: tui
  timeout_ms: 300000
```

## Dashboard

Localhost web UI served from the Airlock process. Live SSE updates, syntax-highlighted argument inspection, keyboard shortcuts, browser notifications, and optional sound alerts. See [Dashboard guide](/guides/dashboard) for details.

```yaml
approvals:
  provider:
    type: dashboard
    host: 127.0.0.1
    port: 4112
  timeout_ms: 300000
```

`host` defaults to `127.0.0.1`. For container deployments where a reverse proxy
needs to reach the dashboard port, set `host: 0.0.0.0` and protect that route at
the proxy layer.

## macOS dialog

Native approve/deny popup via `osascript`. Best for local dev on Mac — the dialog appears even when the terminal is in the background.

```yaml
approvals:
  provider:
    type: macos
  timeout_ms: 300000
```

For a richer experience, see the [macOS Companion app](https://github.com/airlock-dev/airlock/releases/latest) — a native Swift menu bar app that connects to the dashboard SSE endpoint with notifications, approval history, live countdown timers, and auto-reconnect.

## Telegram bot

Long-polls for replies. The bot sends approval requests to the configured chat and waits for `approve <code>` or `deny <code>` replies.

```yaml
approvals:
  provider:
    type: telegram
    bot_token: ${TELEGRAM_BOT_TOKEN}
    chat_id: ${TELEGRAM_CHAT_ID}
  timeout_ms: 300000
  batch_window_ms: 10000
```

## Slack webhook

Sends approval requests via an incoming webhook. Fire-and-forget — pair with slash commands or a separate integration for approvals.

```yaml
approvals:
  provider:
    type: slack
    webhook_url: ${SLACK_WEBHOOK_URL}
  timeout_ms: 300000
  batch_window_ms: 10000
```

## Generic webhook

POSTs `{requests, text}` JSON to a URL. Configurable headers. Use for custom integrations.

```yaml
approvals:
  provider:
    type: webhook
    url: https://hooks.example.com/airlock
    headers:
      Authorization: 'Bearer ${WEBHOOK_SECRET}'
  timeout_ms: 300000
```

## OpenClaw

WebSocket RPC to the OpenClaw gateway. Approval requests are routed into your chat session. See [OpenClaw Setup](/guides/openclaw) for the full walkthrough.

```yaml
approvals:
  provider:
    type: openclaw
    gateway_url: ws://localhost:18789
    token: ${OPENCLAW_TOKEN}
    session_key: 'agent:main:telegram:channel:YOUR_CHAT_ID'
  timeout_ms: 300000
```

## Common options

These options work with all providers:

| Option            | Description                                               | Default          |
| ----------------- | --------------------------------------------------------- | ---------------- |
| `timeout_ms`      | How long to wait for approval before auto-denying         | `300000` (5 min) |
| `batch_window_ms` | Collect requests within this window into one notification | `0` (disabled)   |

## Recommendation

- Use `stdio` or `tui` for local dev
- Use `dashboard` when you want a browser-based approval queue
- Use `macos` (or the Companion app) for native Mac notifications
- Use Telegram, Slack, webhook, or OpenClaw when you want approvals to escape the local terminal
