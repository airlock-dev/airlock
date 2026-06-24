# OpenClaw Setup

[OpenClaw](https://openclaw.ai) is a local-first AI agent that runs as a persistent gateway and connects to messaging platforms like WhatsApp, Telegram, and Slack. Its main agent loop uses native HTTP tools rather than MCP, so Airlock ships a plugin — **airlock-bridge** — that bridges the two.

When the plugin is active, OpenClaw's agent can call any tool Airlock manages, and Airlock enforces your allowlist, HITL approval gates, sandboxing, and audit logging for every call.

## How it works

```
OpenClaw agent
  └─ airlock_github_list_prs()          ← tool registered by the plugin
       └─ POST /agents/openclaw/tools/invoke  → Airlock agent data-plane
            └─ allowlist / HITL gate / execute
                 └─ github MCP server
```

The plugin fetches your agent's tool list from Airlock at startup and registers each one with OpenClaw under an `airlock_` prefix. Tool calls are forwarded to Airlock over the data-plane REST tools endpoints; approvals route back through the OpenClaw HITL provider.

## Setup

### 1. Add an agent to your `airlock.yaml`

```yaml
agents:
  openclaw:
    token: ${OPENCLAW_AIRLOCK_TOKEN}
    allow:
      - 'github/*'
      - 'exec/run'
    ask:
      - 'exec/run' # shell commands require approval
```

Start the Airlock gateway if it isn't already running:

```sh
airlock --config airlock.yaml
```

The bridge uses Airlock's REST tools API on the agent data-plane. Keep
`server.expose_tools_api` enabled:

```yaml
server:
  expose_tools_api: true
```

### 2. Install the plugin

```sh
airlock setup openclaw
```

That's it. The command creates
`~/.openclaw/extensions/airlock-bridge` as a symlink to the bundled plugin and
prints next steps. Because it is a symlink, Airlock upgrades update the plugin
without rerunning setup.

### 3. Restart the OpenClaw gateway

```sh
openclaw restart
```

After restart you should see:

```
[airlock-bridge] Registering N tools for agent "openclaw"
```

## Configuration

By default the plugin connects to the Airlock agent data-plane at `http://localhost:4111` as agent `openclaw`. Override with environment variables in your shell profile if your setup differs:

```sh
export AIRLOCK_URL=http://localhost:4111
export AIRLOCK_AGENT=openclaw
export AIRLOCK_SECRET=your-agent-token  # matches agents.openclaw.token in airlock.yaml
```

Alternatively, use OpenClaw's plugin config:

```sh
openclaw config set extensions.airlock-bridge.url http://localhost:4111
openclaw config set extensions.airlock-bridge.agent openclaw
openclaw config set extensions.airlock-bridge.secret your-agent-token
```

## Approvals

When a tool is in your agent's `ask` list, Airlock pauses the call and sends an approval request to OpenClaw via a WebSocket session. Add the `openclaw` HITL provider to route approvals into your chat:

```yaml
approvals:
  provider:
    type: openclaw
    gateway_url: ws://localhost:18789
    token: ${OPENCLAW_TOKEN}
    session_key: 'agent:main:telegram:channel:YOUR_CHAT_ID'
  timeout_ms: 300000
```

The `session_key` is the OpenClaw session where approval messages appear — typically your main chat channel. Reply with `approve <code>` or `deny <code>` to continue. See [Approvals and Audit](/concepts/approvals-and-audit) for the full approval flow.

## Troubleshooting

**No tools registered** — Check that Airlock is running and `AIRLOCK_URL` points to the right host and port. The plugin logs the error on `gateway_start` if the fetch fails.

**401 Unauthorized** — `AIRLOCK_SECRET` doesn't match the configured agent token in your `airlock.yaml`.

**Tool calls denied** — The tool isn't in the agent's `allow` or `ask` list. Add it or check the tool name with `GET /agents/openclaw/tools` on the agent data-plane.

**Approval messages not appearing** — Verify the `session_key` in the `approvals.provider` config matches a real active OpenClaw session.
