# Sandbox Presets and Variants

Sandboxing lets you turn one underlying capability into multiple policy shapes.

That is useful when you want to reduce approval fatigue without handing out the full-power version of a tool.

## The core pattern

Use `alias_of` to create tool variants:

- a tightly sandboxed variant in `allow`
- a broader variant in `ask`

For example:

- `python/sandboxed` → local transforms only, auto-approved
- `python/full` → broader filesystem/network, requires approval
- `python/github` → GitHub-only network access, requires approval

## OS-level sandboxing

When `sandbox.enabled: true`, Airlock wraps `exec/run` calls with the sandbox
runtime before executing the command. The resolved sandbox controls filesystem
read/write rules and network domains for both the underlying `exec/run` tool and
any `tool_overrides` aliases that point to it.

```yaml
providers:
  exec: builtin

agents:
  claude-code:
    allow:
      - python/sandboxed
    sandbox:
      enabled: true
      presets: [local_transform]
    tool_overrides:
      python/sandboxed:
        alias_of: exec/run
        description: 'Run Python for local transformations only'
```

## Reusable presets

Top-level `sandbox_presets` let you define reusable envelopes once and apply them:

```yaml
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
      denied_domains: []

  npm_registry:
    network:
      allowed_domains:
        - 'registry.npmjs.org'
        - 'npmjs.org'
```

Apply presets agent-wide or per tool variant:

- `sandbox.presets` applies to the whole agent sandbox baseline
- `tool_overrides.<tool>.sandbox_presets` applies only to that tool variant

## Full example

```yaml
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
        - local_transform # Agent-wide baseline

    tool_overrides:
      python/sandboxed:
        alias_of: exec/run
        description: 'Run Python for local transformations only'

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
        description: 'Run Python with GitHub-only network access'
        sandbox_presets:
          - github_only # Reuses the named preset
```

## Preset merge rules

- Explicit `sandbox` values on a tool override win over preset values when they conflict
- Deny lists are additive — denies from presets and explicit config are combined
- Allow lists usually replace the previous value so the tool variant can intentionally define a tighter or broader envelope
- Agent-level presets provide the baseline; tool-level presets and explicit sandbox config refine it

## Approval visibility

When a sandboxed tool call requires approval, Airlock includes the resolved sandbox summary in the approval notification:

- Which presets were applied
- Whether network is disabled or limited to specific domains
- Where writes are allowed
- Which paths are explicitly denied

Audit entries also include the resolved sandbox context alongside the tool arguments.

## What is validated

Current macOS smoke test coverage verifies:

- Allowed writes succeed
- Disallowed writes fail
- Denied reads fail
- `allow_read` carve-outs work
- Deny-all network blocks outbound access
- Allowlisted network domains work for the tested runtime path

## Practical guidance

- Use a sandboxed `allow` variant for cheap local work: JSON transforms, parsing, codegen, text munging
- Keep networked or repo-writing variants in `ask` until you've verified the runtime
- Prefer a small number of named presets: `local_transform`, `github_only`, `npm_registry`, `readonly_repo`
- If a tool needs a one-off tweak, put it in the tool override instead of creating a new preset
