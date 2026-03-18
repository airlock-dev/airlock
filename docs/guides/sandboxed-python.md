# Sandboxed Python Variants

This is one of the best patterns in Airlock right now.

The goal is to let the agent do cheap local scripting without making you approve every trivial transform, while keeping a stronger path available for real scripts.

## Pattern

- `python/sandboxed` is your low-friction path for JSON, text, and local transforms
- `python/full` still exists when the agent genuinely needs more power
- `python/github` is a middle ground when the script needs a narrow network surface

See the [sandbox presets example config](https://github.com/airlock-dev/airlock/blob/main/examples/sandbox-presets.yaml) for a complete version, and use [Local Approval UX](/guides/local-approvals) if you plan to run these variants with `--agent`.
