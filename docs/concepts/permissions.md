# Permissions

Airlock evaluates tool access with one simple model:

- `deny` blocks the call
- `ask` requires human approval
- `allow` permits the call immediately
- anything unmatched is default-denied

Precedence is always:

```text
deny > ask > allow > default-deny
```

## Policy is per agent

Each agent gets its own policy surface. That means `claude-code` can be more restrictive than `helena`, even when both connect through the same Airlock instance.

## Profiles reduce repetition

Use `profiles` when several agents share a policy baseline.

## Tool routing and exec policy are separate

Two checks often apply to shell access:

1. can the agent call the tool at all?
2. which command strings are legal once inside the tool?

That lets you say things like:

- the agent may call `exec/run`
- but only `git status`, `git diff*`, and `npm test*` are auto-allowed
