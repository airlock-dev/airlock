# Sandbox Presets and Variants

Sandboxing lets you turn one underlying capability into multiple policy shapes.

That is useful when you want to reduce approval fatigue without handing out the full-power version of a tool.

## The core pattern

Use `alias_of` to create tool variants:

- a tightly sandboxed variant in `allow`
- a broader variant in `ask`

For example:

- `python/sandboxed` -> local transforms only
- `python/full` -> broader filesystem/network after approval

## Reusable presets

Top-level `sandbox_presets` let you define reusable envelopes once and apply them:

- agent-wide with `sandbox.presets`
- per tool variant with `tool_overrides.<tool>.sandbox_presets`

## What is actually validated

Current macOS smoke coverage verifies:

- allowed writes succeed
- disallowed writes fail
- denied reads fail
- `allow_read` carve-outs work
- deny-all network blocks outbound access
- allowlisted network domains work for the tested runtime path
