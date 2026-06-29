# Docker Deploy

Airlock ships a production Dockerfile for running the gateway on a VPS,
self-hosted server, or container platform. The image is generic: it contains Airlock, Node,
npm/npx, Bash, and runtime libraries, but not your private config or host-specific
tools such as `kubectl`, `gh`, or the Docker CLI.

## Build

```bash
docker build -t airlock-bot .
```

The image runs as a non-root `airlock` user, stores config under `/config`, and
expects persistent data under `/data`.

## Combined Local Run

Create an `.env` file:

```bash
AIRLOCK_API_SECRET=change-me
MANAGEMENT_API_SECRET=change-me-management
EXAMPLE_AGENT_AIRLOCK_TOKEN=change-me-too
```

Then run:

```bash
docker run --rm \
  --env-file .env \
  -v "$PWD/airlock-config:/config" \
  -v airlock-data:/data \
  -v airlock-npm-cache:/home/airlock/.npm \
  -p 127.0.0.1:4111:4111 \
  -p 127.0.0.1:4113:4113 \
  -p 127.0.0.1:4112:4112 \
  airlock-bot
```

Put `airlock.yaml` inside `airlock-config/`. The dashboard writes config changes
to `/config/airlock.yaml` and writes a backup at `/config/airlock.bak`, so mount
the directory rather than a single read-only file when dashboard editing is
enabled.

The loopback port bindings are intentional. Put a TLS/authenticated reverse proxy
on the host, or change the bindings only for a trusted private network.

This single-container mode is convenient for local use. For VPS deployments where
you want the MCP-facing gateway to have read-only config, use split mode.

## Compose

Start from the example:

```bash
cp examples/docker-gateway.yaml examples/airlock.yaml
cp examples/docker-compose.yaml examples/compose.yaml
cd examples
mkdir -p airlock-config
cp airlock.yaml airlock-config/airlock.yaml
docker compose -f compose.yaml up --build -d
```

The compose example runs two services:

| Service             | Command             | Config Mount | Purpose                           |
| ------------------- | ------------------- | ------------ | --------------------------------- |
| `airlock-gateway`   | `airlock gateway`   | `/config:ro` | MCP/runtime enforcement           |
| `airlock-dashboard` | `airlock dashboard` | `/config:rw` | Admin UI, config edits, approvals |

Edit `airlock-config/airlock.yaml` for your providers and agents. The dashboard
can also edit the file and writes `/config/airlock.bak` before saving. If your
providers use `npx`, keep the `airlock-npm-cache` volume so MCP server packages
are not re-downloaded on every restart.

On Linux hosts, make sure the config directory is writable by the container user:

```bash
sudo chown -R 10001:10001 airlock-config
```

If you prefer host-user ownership, run the container with an explicit user in
Compose and make the mounted directory writable by that UID/GID.

## Gateway Config

Inside Docker, the gateway must bind to `0.0.0.0` so Docker can publish it:

```yaml
server:
  port: 4111
  host: 0.0.0.0
  api_secret: ${AIRLOCK_API_SECRET}
  auth_required: true
  require_agent_tokens: true
  expose_tools_api: true
  management_api:
    enabled: true
    api_secret: ${MANAGEMENT_API_SECRET}
    host: 0.0.0.0
    port: 4113
    insecure_remote_bind: true
    expose_hook_api: false
```

In split mode, `airlock gateway` strips the in-process dashboard approval
provider and exposes an authenticated approval/event bridge on the separate
gateway management API. The standalone dashboard talks to that bridge with
`AIRLOCK_GATEWAY_SECRET` or `--gateway-secret`; use the management API secret
for that value when `server.management_api.api_secret` is set.

Keep the management API on loopback when the dashboard runs in the same network
namespace. In split Compose mode, the dashboard reaches the gateway across the
Compose network, so the example sets `management_api.host: 0.0.0.0` and the
required `management_api.insecure_remote_bind: true`. Expose that port only on
trusted networks. Never publish the management API on the same agent-reachable
route as `/agents/*`.

For combined mode, bind the dashboard approval UI to `0.0.0.0` only when the
port is private or protected by your reverse proxy:

```yaml
approvals:
  provider:
    type: dashboard
    host: 0.0.0.0
    port: 4112
```

## Reverse Proxy

A typical VPS deployment has two private upstreams:

| Upstream             | Port   | Purpose                             |
| -------------------- | ------ | ----------------------------------- |
| `airlock-agent`      | `4111` | Agent MCP and REST tool data-plane  |
| `airlock-management` | `4113` | Management API control-plane        |
| `airlock-dashboard`  | `4112` | Browser dashboard and approval flow |

Recommended edge controls:

- Put TLS in front of both ports.
- Keep the dashboard behind an authenticated proxy, private network, or platform
  access control.
- Keep agent clients on bearer tokens even behind the proxy:
  `auth_required: true` and `require_agent_tokens: true`.
- Disable APIs you do not need with `server.expose_tools_api: none` for the
  data-plane REST tools API and `management_api.expose_hook_api: false` for the
  control-plane hook API. Split dashboard mode needs
  `management_api.enabled: true` on a trusted management route.
- Use a narrow browser `allowed_origins` list for the gateway origin you expose.

## Extending the Image

If an Airlock provider needs additional CLIs, build a small derived image:

```dockerfile
FROM airlock-bot:local
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends git openssh-client \
  && rm -rf /var/lib/apt/lists/*
USER airlock
```

For Docker-controlled workflows, prefer exposing a narrow remote API or a
dedicated deploy service over mounting the host Docker socket into Airlock. If
you do mount `/var/run/docker.sock`, treat that container as equivalent to root
on the host.

## Healthcheck

The container healthcheck performs a TCP connection to
`AIRLOCK_HEALTH_HOST:AIRLOCK_HEALTH_PORT` and does not require the management
API to be enabled. Override `AIRLOCK_HEALTH_PORT` if your gateway listens on a
different port.
