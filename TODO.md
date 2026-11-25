# Bugs / Correctness

- [x] Fix: allow and hitl should be mutually exclusive groups, or at least hitl should take priority. not forcing a tool to go in allow and hitl. just to put it in hitl
- [x] Feat: make the exec tool not have special treatment, def not in the config. same of the other built in tools

# Integration Testing

- [x] Test: OpenClaw integration — `airlock-bridge` plugin and policy/HTTP tools API integration covered in `test/openclaw-plugin.test.ts` (live indirect-injection scenarios remain manual QA)
- [ ] Test: OpenClaw native messaging integration as a HITL approval method — verify seamless end-to-end approval flow against a live OpenClaw gateway
- [x] Docs/Marketing: Update public site to emphasize OpenClaw compatibility and its relevance as a security layer against prompt injection + over-privileged MCP tools

# Growth Enablers

- [x] Docs: Nice docs + doc site
- [x] CI: NPM auto release on tags / releases

# High-value Features

- [x] Feat: use MCP tool annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`) for safety tiers (`read` / `write` / `destructive`), tier-scoped grants, approval preview read-only checks, and Command Center / `configure-agent` recommended defaults (with explicit `tool_overrides.<tool>.tier` overrides; runtime policy still stays explicit/fail-closed)
- [x] Feat: argument and command policies (`arg_policy`, `arg_scope` with `value_sets` + `arg_dimensions`, and `command_policy`) to constrain specific tool arguments and CLI-dispatcher commands

# Later

- [x] Feat: risk/safety tiers (`read` / `write` / `destructive`) and flagged/escalation indicators derived from MCP tool annotations (or `tool_overrides.<tool>.tier`) and surfaced across the Command Center Inbox, iOS/macOS companions, and approval notifications
- [x] Feat: MCP configuration wizards — `airlock configure-agent` TUI, `airlock configure-cli` TUI, and the web Command Center (`airlock run` / `airlock configure-web` / `airlock dashboard`) with Agent Composer, tool descriptions, annotation-based defaults, and Policy Assistant
- [ ] Feat: support toml or json5 configs
- [x] Feat: dockerize / sandbox exec tools or mcp's with presets like no network access. e.g would be nice to be able to grant blanket allow for python in a sandbox where it can only do e.g. transformations of data (json parsing etc) but not rm -rf / or exfiltrate data
