# Config Overview

Airlock config is YAML.

Key terminology:

- `providers` declares MCP servers and built-ins
- `ask` is the agent-level routing list for human approval
- `approvals` configures the global approval provider
- `profiles` are reusable permission sets

## Main top-level sections

```yaml
providers:
profiles:
sandbox_presets:
clis:
apis:
agents:
approvals:
security:
audit:
server:
```

## Useful examples

- [Gateway example](https://github.com/airlock-dev/airlock/blob/main/examples/gateway.yaml)
- [Profiles example](https://github.com/airlock-dev/airlock/blob/main/examples/profiles.yaml)
- [Sandbox presets example](https://github.com/airlock-dev/airlock/blob/main/examples/sandbox-presets.yaml)

See [Examples](/reference/examples) for the curated index.
