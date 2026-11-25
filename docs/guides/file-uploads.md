# File Uploads

Airlock supports generic staged file uploads so agents can upload binary or large files from their local disk — such as `.3mf` 3D print archives for Bambuddy, release assets, or screenshots/attachments for forge MCPs (Gitea, Forgejo, GitHub, Linear) — without putting raw file bytes through LLM context and without giving agents upstream credentials.

## How it works

1. **Prepare**: The agent calls `airlock/prepare_upload` with the filename (and optional MIME type / size). Airlock returns an `upload_id`, an `airlock-upload://<id>` handle, and a short-lived, single-use `upload_url`.
2. **Stage**: The agent pushes the file from its local disk to `upload_url` (e.g. `curl -X PUT --data-binary @/path/to/file "<upload_url>"` or `curl -F "file=@/path/to/file" "<upload_url>"`). No Airlock bearer token is needed in bash.
3. **Deliver**: The agent passes `airlock-upload://<id>` into the target tool. The call runs through Airlock's normal allowlist, `command_policy`, `arg_policy`, human-in-the-loop approval (showing verified byte size and SHA-256 alongside the declared/inferred filename and MIME type), and audit log before Airlock delivers the file downstream.

Staged uploads work across all downstream backends:

- **OpenAPI backends (`apis:`)** — `multipart/form-data` and raw binary (`application/octet-stream`, `image/*`, etc.) endpoints stream the staged file directly with Airlock-injected auth headers.
- **Built-in HTTP (`http/post`, `http/put`, `http/patch`)** — pass `multipart` or `body_upload` with `airlock-upload://<id>` refs under existing `domain_allowlist` and `blocked_hosts` controls.
- **Upstream MCP and CLI tools (`providers:`, `clis:`)** — substitute upload handles into tool arguments as `base64`, `data_uri`, `text`, a staged/mounted disk `path`, or a single-use download `url`.

## Enabling uploads

Uploads are disabled by default. Enable them with a top-level `uploads` block and grant `airlock/prepare_upload` (plus optionally `airlock/delete_upload`) to the agents that need it:

```yaml
uploads:
  enabled: true
  dir: /data/uploads # staging directory (defaults to a unique per-instance temp directory; use a volume on read-only containers)
  public_urls: # allowlist of public URLs agents connect through (matches incoming Host / X-Forwarded-Host)
    - https://airlock.example.com
    - https://airlock.tailnet.ts.net
  internal_url: http://airlock-gateway:4111 # optional: URL sidecar MCPs use for :url delivery
  max_file_bytes: 52428800 # 50 MiB default per-agent limit
  max_total_bytes: 524288000 # 500 MiB total staging ceiling (raise when allowing multi-GB agent uploads)
  max_files_per_agent: 100 # default
  max_inline_bytes: 10485760 # 10 MiB cap for base64 / data_uri / text injection (default)
  ttl_ms: 900000 # 15 min staged file lifetime (default)
  ticket_ttl_ms: 300000 # 5 min unused upload URL lifetime (default)
  download_ttl_ms: 120000 # 2 min one-time :url download lifetime (default)
  allowed_modes: [base64, data_uri, text, url] # `path` is off by default
  allowed_mime_types: [] # empty allows all MIME types

agents:
  builder:
    allow:
      - airlock/prepare_upload
      - airlock/delete_upload
    uploads:
      # Optional per-agent overrides: e.g. raise max_file_bytes for a 3D-print or video agent
      # (still bounded by uploads.max_total_bytes), or pin public_url for one network plane.
      max_file_bytes: 268435456 # 256 MiB
```

If Airlock is reachable on multiple hostnames (for example, a Traefik hostname for local workstations and a separate Tailscale hostname for isolated VPS agents), list all of them in `uploads.public_urls`. `airlock/prepare_upload` picks the allowlisted URL matching the request's `Host` / `X-Forwarded-Host` header (ignoring unrecognized host headers) or uses `agents.<name>.uploads.public_url` when pinned.

Raw `PUT` uploads and `:url` downloads stream directly to and from disk without buffering whole files in memory, and disable fixed whole-request timeouts while enforcing a per-chunk stall timeout so multi-GB transfers work without hanging dead connections.

In stdio mode (`airlock --agent <name>`), enabling `uploads.enabled: true` starts an ephemeral loopback upload listener (`127.0.0.1:<random-port>`) so the exact same workflow works locally.

## Example: Bambuddy (OpenAPI `multipart/form-data`)

When an OpenAPI spec declares a `multipart/form-data` or binary (`application/octet-stream`) request body, Airlock automatically exposes file fields as `airlock-upload://<id>` string arguments:

```yaml
uploads:
  enabled: true
  public_url: https://airlock.example.com

apis:
  bambuddy:
    spec: ./bambuddy-openapi.json
    base_url: https://bambuddy.internal
    auth:
      type: bearer
      token: ${BAMBUDDY_TOKEN}

agents:
  printer-agent:
    allow:
      - airlock/prepare_upload
      - bambuddy/list*
      - bambuddy/get*
    ask:
      - bambuddy/upload*
```

The agent calls `airlock/prepare_upload` → uploads `/tmp/bracket.3mf` with `curl` → calls `bambuddy/upload_archive({ file: "airlock-upload://upl_...", printer_id: 1 })`. Your approval card shows `bracket.3mf`, its verified byte size and SHA-256 prefix, and declared/inferred MIME type (`model/3mf`) before anything is sent to Bambuddy.

## Example: Forge MCPs (attachments via `base64`, shared `path`, or one-time `url`)

For upstream MCP servers (Gitea, Forgejo, GitHub, Linear, etc.), there are two ways to wire delivery:

### 1. Configured per-tool mappings (recommended)

Declare `uploads` inside `tool_overrides` (on an agent or shared profile). Airlock automatically annotates the tool's description and parameter schema so agents know to call `airlock_prepare_upload` and pass a bare `airlock-upload://<id>` ref:

```yaml
agents:
  dev:
    allow:
      - airlock/prepare_upload
      - forge/*
    tool_overrides:
      # Forge MCP expecting base64 file content
      forge/upload_issue_attachment:
        uploads:
          content_base64: base64

      # Co-located Docker sidecar MCP sharing the uploads volume at /shared/uploads
      bambuddy_mcp/upload_3mf:
        uploads:
          file_path:
            mode: path
            path_prefix: /shared/uploads

      # Remote MCP that fetches a URL
      linear/attach_file:
        uploads:
          url: url
```

### 2. Zero-config self-describing suffixes

On any MCP tool without a `tool_overrides.<tool>.uploads` mapping, an agent can append a delivery mode suffix directly to the handle:

- `airlock-upload://<id>:base64` — raw Base64 string
- `airlock-upload://<id>:data_uri` — `data:<mime>;base64,<base64>`
- `airlock-upload://<id>:text` — strict UTF-8 text (rejects non-UTF-8 binaries)
- `airlock-upload://<id>:url` — short-lived, single-use HTTP download URL hosted by Airlock (`HEAD` does not consume; `GET` consumes once)
- `airlock-upload://<id>:path` — staged disk path (only permitted when `path` is listed in `allowed_modes` or explicitly mapped in `tool_overrides`)

Inline modes (`base64`, `data_uri`, `text`) are capped by `max_inline_bytes` (default 10 MiB) so large files do not exhaust JSON-RPC memory limits.

## Example: Built-in HTTP uploads

With `providers: { http: builtin }` and `uploads.enabled: true`, `http/post`, `http/put`, and `http/patch` accept two mutually exclusive upload fields alongside `body`:

- `multipart`: object mapping form field names to strings/scalars or `airlock-upload://<id>` refs (or arrays of them).
- `body_upload`: bare `airlock-upload://<id>` ref sent as the raw binary request body (with automatic `Content-Type` from the staged file unless explicitly overridden in `headers`).

```json
{
  "url": "https://bambuddy.example.com/api/v1/archives/upload",
  "multipart": {
    "file": "airlock-upload://upl_x7kP9mQ2vR4tW8yZ3bN5cD",
    "printer_id": 1
  }
}
```

## Direct agent-token HTTP uploads

REST and scripted agents that already hold their agent bearer token can stage files in a single HTTP request without calling `airlock/prepare_upload` first (provided `airlock/prepare_upload` is in the agent's `allow` list):

```bash
curl -X POST https://airlock.example.com/agents/builder/uploads \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "X-Filename: bracket.3mf" \
  --data-binary @./bracket.3mf
```

`multipart/form-data` (`-F "file=@./bracket.3mf"`) is also accepted. Delete a staged file early with `DELETE /agents/:agentId/uploads/:uploadId` (requires `airlock/delete_upload` in the agent's `allow` list).

## Security model

- **Agent and instance isolation**: Every staged upload is bound to the agent that created it, receives a 128-bit random capability `upload_id` (22 base64url chars), and cannot be enumerated by other threads sharing the same agent profile (there is no upload listing tool). When a client supplies a session ID (`X-Airlock-Session-Id`, `?session=`, or `_meta["dev.airlock/session"]`) or uses stdio/SSE, uploads and `max_files` quotas are additionally isolated to `(agentId, sessionId)` alongside aggregate per-agent and gateway record caps.
- **Single-use presigned URLs**: Both upload (`PUT`/`POST /uploads/:token`) and `:url` download (`GET /uploads/dl/:token`) tokens are 256-bit random values stored as SHA-256 digests and consumed atomically on first use.
- **Immutable bytes before HITL**: Upload URLs are single-use and files are validated and pinned before human approval starts (including `airlock/request_approval` plans), with approval grants cryptographically bound to the validated SHA-256 digest and delivery mode. Approval cards display verified byte size and SHA-256 alongside declared/inferred filename and MIME type.
- **Policy enforcement**: Staged upload references cannot be substituted into `exec/run`, `command_policy`-controlled arguments, or `arg_policy`-constrained arguments. `:text` substitutions are validated as strict UTF-8 and scanned by pre-execution detectors before approval.
- **Airlock-owned staging root**: Keep `uploads.dir` owned exclusively by Airlock. When sharing `uploads.dir` with a co-located sidecar for `:path` delivery, mount it read-only (`:ro`) in the sidecar container.
- **Compact audit logs**: Audit rows record the `airlock-upload://<id>` ref plus metadata under `_airlock.uploads`, never raw binary or Base64 payloads.
- **Per-agent limits**: Agents can configure `max_file_bytes` (up to `uploads.max_total_bytes`), `max_inline_bytes`, `max_files`, `allowed_modes`, `allowed_mime_types`, and `public_url` under `agents.<name>.uploads`.
