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

- use `dashboard` as the default local approval experience, especially with `--agent`
- use `macos` when you want lightweight native prompts on macOS
- use `tui` for terminal-native approvals without conflicting with stdio MCP transport
- use Telegram, webhook, Slack, or OpenClaw when you want approvals to escape the local terminal

## Important compatibility note

Do not use `stdio` approvals with `airlock --agent ...`.

The stdio MCP transport already owns stdin/stdout in that mode, so `stdio` HITL is only appropriate outside stdio-agent mode, for testing or full gateway/server workflows.

See [Local Approval UX](/guides/local-approvals).
