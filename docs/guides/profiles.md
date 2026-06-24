# Composable Profiles

Profiles let you define reusable permission and argument-control sets that
agents inherit. Instead of duplicating allow/ask/deny lists or shared argument
scopes across agents, define them once and compose with `extends`.

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

Profiles can also extend other profiles:

```yaml
profiles:
  github-read:
    allow:
      - github/list*
      - github/get*

  linear-read:
    allow:
      - linear/list*
      - linear/get*

  dev-ro:
    extends: [github-read, linear-read]
    allow:
      - sentry/list*

  dev-rw:
    extends: [dev-ro]
    allow:
      - github/create_pr
    ask:
      - github/merge_pull_request
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

This also means a derived profile can downgrade an inherited grant without special syntax. If `base` allows `github/*` and `product` adds `ask: [github/merge_pull_request]`, merge requests require approval because `ask` wins over `allow`.

Profile rules are resolved before agent-level rules are applied:

1. Each profile inherits all transitively extended profiles
2. Diamond inheritance is deduplicated
3. Agent `extends` consumes the fully resolved profiles
4. Agent-level rules are added
5. Precedence resolves conflicts: deny wins over ask, ask wins over allow

Airlock rejects invalid profile graphs at config load. Unknown profile references are fatal, and cycles report the path, for example `pa-work -> product -> pa-work`.

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

### Scoped write access

Profiles can also carry argument controls. Define shared `value_sets` and
`arg_dimensions`, then attach them through a profile-level `arg_scope`:

```yaml
value_sets:
  airlock_repos:
    - airlock-dev/airlock
  safe_fix_branches:
    - 'fix/*'
    - 'feat/*'

arg_dimensions:
  github_repo:
    match: in
    bindings:
      github/push_files: repo
      github/create_pull_request: repo
  github_branch:
    match: glob_in
    bindings:
      github/push_files: branch
      github/create_pull_request: head

profiles:
  airlock-autofix:
    allow:
      - github/push_files
      - github/create_pull_request
    arg_scope:
      github_repo: airlock_repos
      github_branch: safe_fix_branches

agents:
  autofix:
    extends: [airlock-autofix]
```

When the profile is resolved, Airlock expands the scope into concrete
`arg_policy` checks for the bound tool arguments.

## Profiles and sandbox presets

Profiles affect permission rules and argument controls (`arg_policy` / `arg_scope`).
Sandbox presets are configured separately at the agent level or per tool variant.
See [Sandbox Presets and Variants](/concepts/sandboxing) for details.
