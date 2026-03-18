# Providers and Tools

Airlock talks about `providers`, not `mcps`.

A provider is any upstream tool source Airlock can expose to agents.

## Provider types

- MCP providers over `stdio`, `sse`, and `streamable-http`
- built-in providers like `exec` and `http`
- generated providers from CLI discovery and OpenAPI specs

## CLI tools vs `exec/run`

Use `exec/run` when you want general shell access with pattern-based command policy.

Use discovered or hand-written `clis` configs when you want named MCP tools with structured parameters.

## OpenAPI-backed APIs

Airlock can transform OpenAPI operations into MCP tools so they share the same approval and audit path as everything else.
