# API Discovery

Airlock can transform any OpenAPI 3.x spec into namespaced MCP tools. Every endpoint becomes a tool with structured parameters, the same permission engine, and full audit logging.

## Basic usage

```bash
# From a local spec file
airlock discover api ./petstore.json --output petstore-api.yaml

# From a URL
airlock discover api https://api.example.com/openapi.json \
  --base-url https://api.example.com

# Filter endpoints
airlock discover api ./spec.json \
  --include "GET *" --exclude "DELETE *"
```

## Referencing in config

```yaml
apis:
  petstore:
    spec: ./petstore.json
    base_url: https://petstore.example.com/v1
    auth:
      type: bearer
      token: ${PETSTORE_TOKEN}
    timeout_ms: 30000
    max_response_bytes: 1048576
```

Each endpoint becomes a namespaced tool like `petstore/listPets`, `petstore/getPetById`, etc. These tools appear in the agent's tool list and follow the same allow/ask/deny rules as any other tool.

## Auth options

The `auth` block supports:

- **bearer** — sends `Authorization: Bearer <token>` on every request
- **basic** — sends `Authorization: Basic <base64(user:pass)>`

```yaml
apis:
  internal:
    spec: ./internal-api.json
    base_url: https://internal.example.com
    auth:
      type: basic
      username: ${API_USER}
      password: ${API_PASS}
```

## Filtering endpoints

Use `--include` and `--exclude` to control which endpoints are discovered:

- `--include "GET *"` — only include GET endpoints
- `--exclude "DELETE *"` — exclude all DELETE endpoints
- Patterns match against `METHOD /path`

Filtering happens at discovery time — excluded endpoints won't appear in the generated YAML at all.

## How tools are named

Airlock converts OpenAPI operation IDs into tool names. If an operation ID isn't set, Airlock generates one from the HTTP method and path.

For example:

- `GET /pets` with operationId `listPets` → `petstore/listPets`
- `POST /pets/{id}/feed` without operationId → `petstore/post_pets_id_feed`

## Combining with permissions

Once discovered, API tools work like any other tool:

```yaml
agents:
  claude-code:
    allow:
      - petstore/list*
      - petstore/get*
    ask:
      - petstore/create*
      - petstore/update*
    deny:
      - petstore/delete*
```
