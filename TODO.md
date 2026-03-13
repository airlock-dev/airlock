# Bugs / Correctness
- [x] Fix: allow and hitl should be mutually exclusive groups, or at least hitl should take priority. not forcing a tool to go in allow and hitl. just to put it in hitl
- [x] Feat: make the exec tool not have special treatment, def not in the config. same of the other built in tools

# Integration Testing
- [ ] Test: OpenClaw integration — key use case given its MCP tool access + high prompt injection / indirect injection exposure (malicious content in docs/emails/web hijacking tool calls)
- [ ] Test: OpenClaw native messaging integration as a HITL approval method — verify seamless end-to-end approval flow
- [ ] Docs/Marketing: Update public site to emphasize OpenClaw compatibility and its relevance as a security layer against prompt injection + over-privileged MCP tools

# Growth Enablers
- [ ] Docs: Nice docs + doc site
- [ ] CI: NPM auto release on tags / releases

# High-value Features
- [ ] Feat: use MCP tool annotations (readOnlyHint, destructiveHint, idempotentHint, openWorldHint) to drive allow/HITL/deny routing logic, rather than relying solely on tool name matching or user-defined patterns
- [ ] Feat: middleware to deny specific queries, eg for supabase_execute_sql, deny some table or column names

# Later
- [ ] Feat: add a "risk level" to each action that needs approval, so you can see at a glance in teh notificaiton what the risk is. Emoji in the popup etc. Could have defaults like read is basic, write is elevated, delete is critical read from the mcp tool definition tags
- [ ] Feat:  MCP wizard: will open a nice webpage or tui, help you get connected to the mcp, then go over all the tools hoswing the description and letting you set approve/hitl/deny on each one.
- [ ] Feat: support toml of json5 configs
- [ ] Feat: dockerize / sandbox exec tools or mcp's with presets like no network access. e.g would be nice to be able to grant blanket allow for python in a sandbox where it can only do e.g. transformations of data (json parsing etc) but not rm -rf / or exfiltrate data