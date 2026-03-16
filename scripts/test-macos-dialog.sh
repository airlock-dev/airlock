#!/usr/bin/env bash
# Spawns Airlock with the echo server and triggers a macOS approval dialog.
# Usage: ./scripts/test-macos-dialog.sh
set -euo pipefail

cd "$(dirname "$0")/.."

# Kill any stale echo-server or airlock processes on port 4112
pkill -f "echo-server" 2>/dev/null || true
sleep 0.5

LOG=$(mktemp /tmp/airlock-test-XXXXXXXX)
echo "Logs: $LOG"

# Send initialize + echo/echo (ask-listed) tool call via stdin
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0.1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"echo/add","arguments":{"a":1,"b":2}}}' \
| LOG_LEVEL=debug node dist/index.js --agent dev -c local/airlock.yaml 2>"$LOG"

echo ""
echo "=== Response above, logs below ==="
echo ""
cat "$LOG"
