# Local Approval UX

If you run Airlock with `--agent`, it is acting as an MCP server over stdio.

That means the `stdio` approval provider is **not** compatible with this mode, because both the MCP transport and the approval provider would compete for stdin/stdout.

## Recommended local defaults

For local development with Claude Code or other stdio MCP clients, prefer one of these:

- `dashboard` for a browser-based approval queue
- `macos` for lightweight native approval prompts on macOS
- `tui` if you want a terminal UI that uses `/dev/tty` instead of the MCP transport stream

## Dashboard

The dashboard is the best default for most users.

- browser-based
- works well alongside Claude Code stdio mode
- good for batched approvals and queue visibility

```yaml
approvals:
  provider:
    type: dashboard
  timeout_ms: 300000
```

## macOS companion

If you are developing on macOS and want a more native approval flow, use the macOS provider or the companion app workflow.

```yaml
approvals:
  provider:
    type: macos
  timeout_ms: 300000
```

This is a great fit when you want approvals to feel local and low-friction.

## When `stdio` still makes sense

The `stdio` provider is still useful in gateway/server mode, local testing, and CI-ish debugging, but not when Airlock itself is serving MCP over stdio with `--agent`.
