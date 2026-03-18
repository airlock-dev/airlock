# CLI Discovery Wizard

Airlock can discover CLI commands and turn them into named MCP tools.

## Discovery paths

Airlock prefers machine-readable sources over help text when possible:

- Fig specs if explicitly requested
- completion adapters for frameworks like Cobra, Click/Typer, Clap, and shell-generated completion flows
- help-text parsing as fallback

## Interactive workflow

```bash
airlock configure-cli gh
```

The configurator lets you:

- lazy-load command groups instead of crawling the whole tree up front
- toggle commands and groups
- inspect command params
- search with `/`
- export or merge generated YAML
