# Approvals and Audit

Airlock's safety story is policy plus visibility.

## Approval providers

Supported approval backends include:

- stdio
- TUI
- dashboard
- macOS dialogs
- Telegram
- Slack webhook
- generic webhook
- OpenClaw

## What an approval includes

Approval payloads include the agent, tool, input args, and sandbox context when relevant.

For sandboxed variants, operators can see details like:

- applied preset names
- allowed network domains
- writable paths
- denied read paths

## Audit log

Every tool call is recorded to SQLite with agent, tool, args, result, duration, and HITL outcome.

For sandboxed tools, the resolved sandbox info is included alongside the recorded args.
