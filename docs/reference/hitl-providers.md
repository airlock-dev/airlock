# HITL Providers

Airlock supports several approval backends.

## Providers

- `stdio`
- `tui`
- `dashboard`
- `macos`
- `telegram`
- `slack`
- `webhook`
- `openclaw`

## Recommendation

- use `stdio` or `tui` for local dev
- use `dashboard` when you want a browser-based approval queue
- use Telegram, webhook, Slack, or OpenClaw when you want approvals to escape the local terminal
