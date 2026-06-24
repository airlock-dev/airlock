# Middleware Pipeline

Airlock runs a fixed security pipeline around every tool call, plus optional
per-agent middleware that can inspect, block, transform, or annotate requests
and responses.

## Configuration Shape

Configurable middleware lives on an agent, not at the top level:

```yaml
agents:
  claude-code:
    allow:
      - github/*
    middleware:
      - name: injection-detector
        backend: regex
        mode: escalate
      - name: rate-limiter
        max_requests: 100
        window_ms: 60000
        per: agent
      - name: output-size-limiter
        max_lines: 200
        max_chars: 30000
```

If `middleware` is omitted, Airlock enables these configurable defaults:

- `schema-validator`
- `untrusted-envelope`
- `output-injection-detector` in `detect` mode

Set `middleware: []` to run only the fixed core pipeline. To turn off one
default while keeping the others, add it with `enabled: false`:

```yaml
agents:
  claude-code:
    middleware:
      - name: untrusted-envelope
        enabled: false
```

Every configurable middleware can be limited by tool glob:

```yaml
agents:
  claude-code:
    middleware:
      - name: untrusted-envelope
        tools: ['github/*']
        exclude: ['github/internal']
```

## Execution Order

The fixed core always runs in this order:

```text
allowlist
  -> exec-policy
  -> schema-validator
  -> arg-policy
  -> injection-detector / sensitivity-classifier
  -> sandbox
  -> hitl-gate
  -> execute
```

`schema-validator`, `injection-detector`, and `sensitivity-classifier` run in
the core zone even though they are configurable. Other configurable middleware
wraps the core pipeline, so it can inspect the request before execution and the
response on the way back.

## Core-Zone Middleware

### Schema Validator

Validates tool arguments against the tool's JSON Schema using Ajv. Malformed
calls are rejected before execution.

```yaml
agents:
  claude-code:
    middleware:
      - name: schema-validator
```

### Injection Detector

Scans tool arguments, and also scans responses after execution, for prompt
injection patterns.

Backends:

- `regex` (default) - local pattern matching
- `deberta` - sends text to a DeBERTa inference server

Modes:

- `detect` - log and audit detections
- `mangle` - redact matched response text
- `escalate` - require approval when arguments look injected

```yaml
agents:
  claude-code:
    middleware:
      - name: injection-detector
        backend: regex
        mode: escalate
        threshold: 0.8
```

### Sensitivity Classifier

Detects PII and sensitive data in arguments and responses. Argument detections
can escalate to approval.

Backends:

- `heuristic` (default) - regex and weighted scoring
- `llm` - calls a model through the AI SDK

```yaml
agents:
  claude-code:
    middleware:
      - name: sensitivity-classifier
        backend: heuristic
        mode: escalate
        threshold: 0.7
```

## Wrapping Middleware

### Rate Limiter

Sliding-window rate limiter. Limits can be per agent or per tool.

```yaml
agents:
  claude-code:
    middleware:
      - name: rate-limiter
        max_requests: 100
        window_ms: 60000
        per: agent
```

### Untrusted Envelope

Wraps tool responses in randomized untrusted-output tags so untrusted content
cannot reliably terminate the envelope.

```yaml
agents:
  claude-code:
    middleware:
      - name: untrusted-envelope
```

### Output Injection Detector

Scans tool responses for prompt injection attempts before they reach the agent.

Modes:

- `detect` - log and audit detections
- `mangle` - replace matched text with `[REDACTED: suspected injection]`

```yaml
agents:
  claude-code:
    middleware:
      - name: output-injection-detector
        mode: mangle
```

### Strip Query Params

Strips query parameters from `http/get` and `http/head` URLs. This middleware is
not enabled by default; add it when you want read-only HTTP calls to avoid query
string exfiltration.

```yaml
agents:
  claude-code:
    middleware:
      - name: strip-query-params
```

### Canary Token Injector

Injects short-lived canary markers into tool outputs. If a later tool call
contains one of those markers in its arguments, Airlock audits the leak and, by
default, marks the call as needing approval.

```yaml
agents:
  claude-code:
    middleware:
      - name: canary-token-injector
        mode: escalate
```

Use `mode: detect` to audit canary leaks without escalating.

### Output Size Limiter

Truncates large outputs to avoid context-window exhaustion. The response marks
that it was truncated and includes the path to the full output.

```yaml
agents:
  claude-code:
    middleware:
      - name: output-size-limiter
        max_lines: 200
        max_chars: 30000
```

### Output Summarizer

For responses over a character threshold, calls a model through the AI SDK to
summarize before passing content to the agent. If summarization fails, Airlock
falls back to the original response.

```yaml
agents:
  claude-code:
    middleware:
      - name: output-summarizer
        model: claude-haiku-4-5-20251001
        threshold_chars: 10000
```

## Audit Visibility

Middleware detections are logged alongside normal audit entries. Injection
detection, sensitivity classification, output injection detection, and canary
leak detection all write audit records when they flag something.
