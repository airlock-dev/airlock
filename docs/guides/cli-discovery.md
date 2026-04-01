# CLI Discovery

Airlock can discover CLI commands and turn them into named MCP tools.

## Discovery strategies

Airlock uses three strategies in order of preference, picking the richest source available:

### 1. Fig autocomplete specs

Structured autocomplete definitions from the [Fig](https://github.com/withfig/autocomplete) project. Richest source of subcommand and flag metadata. Explicitly requested with `--fig`:

```bash
airlock discover cli kubectl --fig
```

### 2. Shell completion adapters

Hooks into CLI framework-specific completion systems:

- **Cobra** (Go) — used by `kubectl`, `gh`, `docker`, `helm`
- **Click / Typer** (Python) — used by many Python CLIs
- **Clap** (Rust) — used by Rust CLIs
- **Shell-generated** completions — bash/zsh/fish completion scripts

Airlock detects the framework automatically and uses the CLI's own tab-completion mechanism to enumerate subcommands and flags programmatically.

### 3. Help text parsing

Fallback strategy. Parses `--help` output to extract subcommands and flags. Works with any CLI but produces less structured results.

```bash
airlock discover cli git --output git-commands.yaml
```

## Basic usage

```bash
# Parse --help output (works with any CLI)
airlock discover cli docker

# Try Fig specs first, fall back to --help
airlock discover cli kubectl --fig

# Write to a file, limit recursion depth
airlock discover cli git --output git-commands.yaml --max-depth 2

# Only include specific commands
airlock discover cli npm --include install,test,run
```

## Referencing discovered commands in config

```yaml
clis:
  git:
    discovered: ./git-commands.yaml
    shell: /bin/bash
    max_output_bytes: 30000 # Default matches Claude Code's limit
    commands:
      # Inline commands override discovered ones with the same name
      custom-deploy:
        exec: 'git push origin main'
        params: {}
```

Inline commands in the `commands` block take precedence over discovered commands with the same name.

## Interactive configuration

The `configure-cli` TUI provides a richer workflow than discovery alone:

```bash
airlock configure-cli gh
```

Features:

- **Lazy loading** — command groups are loaded on demand instead of crawling the whole tree upfront
- **Toggle commands** — enable/disable individual commands or entire groups
- **Inspect params** — view command parameters and their types
- **Search** — press `/` to filter commands
- **Export options** — write YAML to file, merge into existing config, or copy to clipboard

The TUI is ideal for large CLIs with hundreds of subcommands (like `kubectl` or `docker`) where you only want to expose a subset.

## Command structure

Discovered commands follow this structure:

```yaml
status:
  exec: git status
  description: Show the working tree status
  params: {}

log:
  exec: 'git log --oneline -n {count}'
  description: Show commit logs
  params:
    count:
      type: number
      required: false
      default: 10
      description: Number of commits to show
```

Each command becomes a namespaced MCP tool (e.g. `git/status`, `git/log`) that agents can call with structured parameters.
