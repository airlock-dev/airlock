# Composable Profiles

Profiles let you define reusable permission sets that agents inherit. Instead of duplicating allow/ask/deny lists across agents, define them once and compose with `extends`.

## Defining profiles

Profiles are top-level in your config:

```yaml
profiles:
  readonly:
    allow:
      - github/list*
      - github/get*
      - http/get

  developer:
    allow:
      - github/*
      - git/*
      - exec/run
    ask:
      - github/create_pr
      - github/merge_pull_request

  ops:
    allow:
      - sentry/*
      - posthog/*
    ask:
      - exec/run
```

## Using extends

Agents inherit from one or more profiles:

```yaml
agents:
  claude-code:
    extends: [readonly]

  helena:
    extends: [readonly, developer]
    deny:
      - exec/run # Agent-level deny overrides everything
```

## Merge precedence

When multiple profiles contribute rules, and the agent has its own rules, they merge with the same precedence as always:

```
deny > ask > allow > default-deny
```

If `readonly` allows `http/get` and the agent denies `http/*`, the deny wins.

Profile rules are combined before agent-level rules are applied:

1. All `allow` lists from all profiles are merged
2. All `ask` lists from all profiles are merged
3. All `deny` lists from all profiles are merged
4. Agent-level rules are applied on top
5. Precedence resolves conflicts: deny wins over ask, ask wins over allow

## Practical patterns

### Read-only base with escalation

```yaml
profiles:
  readonly:
    allow:
      - '*/list*'
      - '*/get*'
      - '*/search*'
      - http/get
```

Most agents start here. Only explicitly add write capabilities.

### Tiered developer access

```yaml
profiles:
  dev-safe:
    allow:
      - git/status
      - git/diff
      - exec/run
    ask:
      - git/push
      - git/commit

  dev-full:
    allow:
      - git/*
      - github/*
    ask:
      - github/merge_pull_request
```

### Per-environment profiles

```yaml
profiles:
  staging:
    allow:
      - deploy/staging
    deny:
      - deploy/production

  production:
    ask:
      - deploy/production
    deny:
      - deploy/staging
```

## Profiles and sandbox presets

Profiles only affect allow/ask/deny rules. Sandbox presets are configured separately at the agent level or per tool variant. See [Sandbox Presets and Variants](/concepts/sandboxing) for details.
