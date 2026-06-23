# Middleware Pipeline

Airlock runs a composable middleware stack on every tool call. Each middleware can inspect, block, transform, or annotate the request before and after the downstream tool executes.

## Architecture

Middleware executes as a chain. Each layer receives the tool call context and a `next()` function. Calling `next()` passes control to the next middleware, eventually reaching the actual tool execution. Post-execution middleware can inspect and transform the response on the way back.

```
Agent request
  → injection detector
    → sensitivity classifier
      → rate limiter
        → schema validator
          → allowlist check
            → HITL gate (if ask)
              → sandbox enforcement
                → tool execution
              ← canary token injector
            ← output injection detector
          ← untrusted envelope
        ← output size limiter
      ← output summarizer
    ← strip query params
  ← response to agent
```

## Pre-Execution Middleware

### Injection Detector

Scans inbound tool arguments for prompt injection patterns.

Two backends:

- **regex** (default) — fast pattern matching against known injection phrases like "ignore all previous instructions", "you are now a", `<system>` tags, `[INST]` markers, etc.
- **deberta** — sends text to a DeBERTa inference server for ML-based classification at a configurable confidence threshold.

Three modes:

- `detect` — log a warning, allow the call to proceed
- `mangle` — redact the matched content
- `escalate` — escalate to HITL approval regardless of the tool's allow/ask/deny status

```yaml
middleware:
  injection_detector:
    backend: regex # or "deberta"
    mode: escalate
    # DeBERTa-specific:
    inference_url: http://localhost:8000/predict
    threshold: 0.8
```

### Sensitivity Classifier

Detects PII and sensitive data in tool arguments before execution.

Detected patterns include:

- Social Security Numbers
- Credit card numbers
- Email addresses and phone numbers
- API keys and tokens (generic and AWS-specific)
- Private keys (RSA, etc.)
- JWTs

Two backends:

- **heuristic** (default) — regex patterns with weighted scoring
- **llm** — uses a language model for classification

```yaml
middleware:
  sensitivity_classifier:
    mode: detect # or "escalate"
    threshold: 0.7
    backend: heuristic # or "llm"
    model: claude-haiku-4-5-20251001 # for llm backend
```

### Rate Limiter

Sliding-window rate limiter. Prevents runaway agents from hammering downstream tools.

Configurable per-agent or per-tool:

```yaml
middleware:
  rate_limiter:
    max_requests: 100
    window_ms: 60000
    per: agent # or "tool"
```

### Schema Validator

Validates tool arguments against the tool's JSON Schema using Ajv. Malformed calls are rejected before they reach the downstream tool.

Enabled by default. No configuration needed.

## Post-Execution Middleware

### Canary Token Injector

Injects invisible markers into tool outputs. On subsequent tool calls, Airlock checks if any canary token from a previous response appears in the new request's arguments.

If the agent reads a file and then feeds that content into a shell command, the canary token will be detected and escalated to HITL by default, flagging a potential data exfiltration path before the call executes. Set `mode: detect` to log only.

Tokens expire after 10 minutes and are tracked per agent and tool.

```yaml
middleware:
  canary_tokens: true
```

### Output Injection Detector

Scans tool _responses_ for prompt injection attempts before they reach the agent. This catches scenarios where a malicious file, web page, or API response tries to hijack the agent.

- `detect` — log a warning
- `mangle` — replace matched patterns with `[REDACTED: suspected injection]`

```yaml
middleware:
  output_injection:
    mode: mangle
```

### Untrusted Output Envelope

Wraps all tool responses in per-response tags such as `<untrusted-output-a1b2c3d4e5f6 tool="..." call-id="...">`. The randomized suffix is echoed in the close tag so untrusted output cannot reliably terminate the envelope with a fixed `</untrusted-output>` string.

```yaml
middleware:
  untrusted_envelope: true
```

### Output Size Limiter

Truncates large outputs to prevent context window exhaustion. The full output is written to a temp file, and the truncated response includes a path to the full content.

```yaml
middleware:
  output_size_limiter:
    max_lines: 200
    max_chars: 30000
```

### Output Summarizer

For responses over a character threshold, calls a fast LLM to summarize before passing to the agent. Falls back gracefully if the AI SDK or model is unavailable.

```yaml
middleware:
  output_summarizer:
    model: claude-haiku-4-5-20251001
    threshold_chars: 10000
```

### Strip Query Params

Automatically strips query parameters from read-only HTTP tool calls (`http/get`, `http/head`) to prevent data exfiltration via URL query strings.

Enabled by default for HTTP tools.

## Audit Visibility

Middleware actions are logged alongside normal audit entries. The injection detector, sensitivity classifier, and canary token injector all write to the audit log when they detect something, so you have a full record of what was flagged and why.
