# Airlock

Permissions-aware MCP gateway with human-in-the-loop approval for AI agents.

## Commits

Use conventional commits for all commit messages:

- `feat:` — new feature (minor version bump)
- `fix:` — bug fix (patch version bump)
- `refactor:` — code restructuring, no behavior change
- `docs:` — documentation only
- `test:` — adding/updating tests
- `chore:` — maintenance, deps, CI
- `feat!:` or `fix!:` — breaking change (major version bump)

Scope is optional: `feat(config):`, `fix(ci):`, etc.

## Testing

Run tests with: `npx vitest run`
Typecheck with: `npm run typecheck`

## Config

Config uses YAML. Key terminology:
- `providers` (not `mcps`) — declares MCP servers and builtins
- `ask` (not `hitl`) — agent-level tool routing for human approval
- `approvals` (not `hitl`) — top-level approval provider config
- `profiles` — reusable permission sets that agents inherit via `extends`
- Precedence: deny > ask > allow > default-deny

## CLI

- `--agent` (not `--profile`) — selects which agent to run in stdio mode
