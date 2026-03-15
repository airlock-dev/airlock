# OpenClaw Provider Setup

The `openclaw` approval provider delivers approval requests to your OpenClaw session
(Telegram, Discord, etc.) and listens for replies.

## Configuration

```yaml
approvals:
  provider:
    type: openclaw
    gateway_url: ws://localhost:18789
    token: ${OPENCLAW_TOKEN}
    session_key: 'agent:main:telegram:channel:YOUR_CHAT_ID'
    # or just "main" for the default session
```

Set `OPENCLAW_TOKEN` in your environment:

```sh
export OPENCLAW_TOKEN=your-openclaw-bearer-token
```

## How It Works

1. When Airlock needs approval, it sends a `chat.send` RPC over WebSocket to OpenClaw.
2. OpenClaw delivers the message to your configured channel (Telegram, Discord, etc.).
3. You reply with: `approve A1B2C3` or `deny A1B2C3`
4. Airlock's WebSocket listener picks up the reply and resolves the pending request.

## Session Key Format

- Default session: `"main"`
- Telegram channel: `"agent:main:telegram:channel:<chat_id>"`
- Discord channel: `"agent:main:discord:channel:<channel_id>"`

## Wire OpenClaw in `openclaw.json`

Ensure the agent that will receive HITL messages has access to the session.
In your openclaw config, the relevant agent should have the session key configured.

## Systemd Integration

If running both services on the same host, configure Airlock to start after OpenClaw:

```ini
# airlock.service
[Unit]
After=openclaw-gateway.service
```

See `../airlock.service` for the full unit file.
