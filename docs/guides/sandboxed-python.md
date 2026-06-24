# Sandboxed Python Variants

This is one of the best patterns in Airlock right now.

The goal is to let the agent do cheap local scripting without making you approve every trivial transform, while keeping a stronger path available for real scripts.

## The pattern

- `python/sandboxed` is your low-friction path for JSON, text, and local transforms
- `python/full` still exists when the agent genuinely needs more power
- `python/github` is a middle ground when the script needs a narrow network surface

## How it works

All three variants use `alias_of: exec/run` — they're the same underlying tool with different security envelopes. The agent sees them as separate tools with different descriptions and chooses the right one for the task.

## Current implementation

Airlock does not expose a separate Python provider. These variants are aliases
of `exec/run`, and sandboxing is applied by enabling the agent sandbox and
setting sandbox presets or per-tool overrides. That keeps all command policy,
approval, audit, and sandbox behavior on the same execution path.

## Full config example

```yaml
providers:
  exec: builtin

sandbox_presets:
  local_transform:
    filesystem:
      allow_read: ['.']
      allow_write: ['/tmp', '/private/tmp']
      deny_read: ['~/.ssh', '~/.aws', '.env']
      deny_write: ['.']
    network:
      allowed_domains: []

  github_only:
    network:
      allowed_domains:
        - 'github.com'
        - '*.github.com'
        - 'api.github.com'

agents:
  claude-code:
    allow:
      - python/sandboxed
    ask:
      - python/full
      - python/github

    sandbox:
      enabled: true
      presets:
        - local_transform

    tool_overrides:
      python/sandboxed:
        alias_of: exec/run
        description: 'Run Python for local transformations only (no network, writes to /tmp only)'

      python/full:
        alias_of: exec/run
        description: 'Run Python with broader permissions after approval'
        sandbox:
          filesystem:
            allow_write: ['.', '/tmp', '/private/tmp']
            deny_write: []
          network:
            allowed_domains: ['pypi.org', '*.pythonhosted.org']

      python/github:
        alias_of: exec/run
        description: 'Run Python with GitHub-only network access after approval'
        sandbox_presets:
          - github_only
```

## What each variant can do

| Capability           | `python/sandboxed`   | `python/full`                  | `python/github`                  |
| -------------------- | -------------------- | ------------------------------ | -------------------------------- |
| Read project files   | Yes                  | Yes                            | Yes                              |
| Write to /tmp        | Yes                  | Yes                            | Yes                              |
| Write to project dir | No                   | Yes (after approval)           | No                               |
| Network access       | None                 | pypi.org only (after approval) | github.com only (after approval) |
| Requires approval    | No                   | Yes                            | Yes                              |
| Denied paths         | ~/.ssh, ~/.aws, .env | ~/.ssh, ~/.aws, .env           | ~/.ssh, ~/.aws, .env             |

## When to use which

- **python/sandboxed**: JSON transforms, CSV parsing, text munging, code generation, local data processing — anything that reads files and writes to /tmp
- **python/full**: Installing packages, writing generated code to the repo, running scripts that need pip
- **python/github**: API scripts that fetch from GitHub, release automation, PR data analysis

## Approval experience

When the agent calls `python/full`, the approval notification includes:

```
APPROVE? [A1B2C3]
Agent:   claude-code
Tool:    python/full
Sandbox: write:.,/tmp | network:pypi.org,*.pythonhosted.org | deny-read:~/.ssh,~/.aws,.env
Command: python3 -c "import requests; ..."
```

The sandbox context is visible so you know exactly what the script can do before approving.

See `examples/sandbox-presets.yaml` for the complete reference config.
