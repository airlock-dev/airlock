#!/bin/bash
# Airlock adapter for Claude Code PreToolUse hooks.
#
# Reads Claude Code's hook JSON from stdin, POSTs to Airlock's /hook
# endpoint, and returns the decision in Claude Code's expected format.
#
# Environment variables:
#   AIRLOCK_URL    — Airlock gateway URL (default: http://localhost:4111)
#   AIRLOCK_SECRET — API secret for authentication (optional)
#   AIRLOCK_AGENT  — Agent profile to use (optional, defaults to "claude-code")
#
# Install in .claude/settings.json:
# {
#   "hooks": {
#     "PreToolUse": [
#       {
#         "hooks": [
#           {
#             "type": "command",
#             "command": "/path/to/scripts/claude-code-hook.sh"
#           }
#         ]
#       }
#     ]
#   }
# }

set -euo pipefail

AIRLOCK_URL="${AIRLOCK_URL:-http://localhost:4111}"

INPUT=$(cat -)

TOOL=$(echo "$INPUT" | jq -r '.tool_name')
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}')
SESSION=$(echo "$INPUT" | jq -r '.session_id // "unknown"')

AUTH_HEADER=""
if [ -n "${AIRLOCK_SECRET:-}" ]; then
  AUTH_HEADER="Authorization: Bearer ${AIRLOCK_SECRET}"
fi

# POST to Airlock — long-polls if HITL approval is needed
RESPONSE=$(curl -s --fail-with-body \
  -X POST "${AIRLOCK_URL}/hook" \
  -H "Content-Type: application/json" \
  ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
  --max-time 600 \
  -d "$(jq -n \
    --arg client "claude-code" \
    --arg agent "${AIRLOCK_AGENT:-}" \
    --arg tool "$TOOL" \
    --argjson input "$TOOL_INPUT" \
    --arg session_id "$SESSION" \
    '{client: $client, tool: $tool, input: $input, session_id: $session_id} + (if $agent != "" then {agent: $agent} else {} end)'
  )" 2>/dev/null) || {
  # If Airlock is unreachable, fail closed
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Airlock gateway unreachable"
    }
  }'
  exit 0
}

DECISION=$(echo "$RESPONSE" | jq -r '.decision')
REASON=$(echo "$RESPONSE" | jq -r '.reason // empty')

if [ "$DECISION" = "allow" ]; then
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow"
    }
  }'
elif [ "$DECISION" = "deny" ]; then
  jq -n --arg reason "$REASON" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
else
  # Unexpected response — fail closed
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Unexpected response from Airlock"
    }
  }'
fi
