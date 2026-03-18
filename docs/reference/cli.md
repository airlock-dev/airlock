# CLI Commands

## Run the gateway

```bash
airlock --config airlock.yaml
```

## Run stdio mode for a specific agent

```bash
airlock --agent claude-code --config airlock.yaml
```

## Discover CLI tools

```bash
airlock discover cli gh --output gh-commands.yaml
```

## Discover API tools

```bash
airlock discover api ./openapi.json --output api-tools.yaml
```

## Configure a CLI interactively

```bash
airlock configure-cli gh
```
