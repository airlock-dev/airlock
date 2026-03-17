import type { AgentConfig } from '../config/schema.js';
import type { Middleware, MiddlewareDeps } from './types.js';
import { compose } from './compose.js';
import { allowlistMiddleware } from './core/allowlist.js';
import { execPolicyMiddleware } from './core/exec-policy.js';
import { hitlGateMiddleware } from './core/hitl-gate.js';
import { executeMiddleware } from './core/execute.js';
import { sandboxMiddleware } from './core/sandbox.js';
import { schemaValidatorMiddleware } from './core/schema-validator.js';
import { rateLimiterMiddleware } from './core/rate-limiter.js';
import { untrustedEnvelopeMiddleware } from './post/untrusted-envelope.js';
import { stripQueryParamsMiddleware } from './post/strip-query-params.js';
import { outputInjectionDetectorMiddleware } from './post/output-injection-detector.js';
import { canaryTokenInjectorMiddleware } from './post/canary-token-injector.js';
import { outputSizeLimiterMiddleware } from './post/output-size-limiter.js';
import { outputSummarizerMiddleware } from './post/output-summarizer.js';
import { injectionDetectorMiddleware } from './detectors/injection-detector.js';
import { sensitivityClassifierMiddleware } from './detectors/sensitivity-classifier.js';
import { matches } from '../allowlist/pattern.js';
import type { MiddlewareItemConfig } from '../config/schema.js';

function shouldRunForTool(toolName: string, tools?: string[], exclude?: string[]): boolean {
  if (exclude?.some((p) => matches(p, toolName))) return false;
  if (tools && !tools.some((p) => matches(p, toolName))) return false;
  return true;
}

function withToolFilter(mw: Middleware, item: MiddlewareItemConfig): Middleware {
  if (!item.tools && !item.exclude) return mw;
  return (ctx, next) => {
    if (!shouldRunForTool(ctx.toolName, item.tools, item.exclude)) return next();
    return mw(ctx, next);
  };
}

function resolveMiddleware(item: MiddlewareItemConfig): Middleware {
  switch (item.name) {
    case 'schema-validator':
      return schemaValidatorMiddleware();
    case 'rate-limiter':
      return rateLimiterMiddleware({
        max_requests: item.max_requests ?? 60,
        window_ms: item.window_ms ?? 60_000,
        per: item.per,
      });
    case 'untrusted-envelope':
      return untrustedEnvelopeMiddleware();
    case 'strip-query-params':
      return stripQueryParamsMiddleware();
    case 'output-injection-detector':
      return outputInjectionDetectorMiddleware({
        mode: item.mode as 'detect' | 'mangle' | undefined, // schema includes 'escalate' which is not valid for output-injection-detector
      });
    case 'canary-token-injector':
      return canaryTokenInjectorMiddleware();
    case 'output-size-limiter':
      return outputSizeLimiterMiddleware({
        max_lines: item.max_lines,
        max_chars: item.max_chars,
      });
    case 'output-summarizer':
      return outputSummarizerMiddleware({
        model: item.model ?? 'claude-haiku-4-5-20251001',
        threshold_chars: item.threshold_chars,
      });
    case 'injection-detector':
      return injectionDetectorMiddleware({
        backend: item.backend as 'regex' | 'deberta' | undefined,
        mode: item.mode,
        inference_url: item.inference_url,
        threshold: item.threshold,
      });
    case 'sensitivity-classifier':
      return sensitivityClassifierMiddleware({
        mode: item.mode as 'detect' | 'escalate' | undefined,
        threshold: item.threshold,
        backend: item.backend as 'heuristic' | 'llm' | undefined,
        model: item.model,
      });
    default:
      throw new Error(`Unknown middleware: ${(item as { name: string }).name}`);
  }
}

const DEFAULT_MIDDLEWARE: MiddlewareItemConfig[] = [
  { name: 'schema-validator', enabled: true },
  { name: 'untrusted-envelope', enabled: true },
  { name: 'output-injection-detector', mode: 'detect', enabled: true },
];

/**
 * Builds the complete middleware chain for an agent.
 *
 * Core zone (fixed order, always present):
 *   allowlist → exec-policy → schema-validator → [detectors from config] → hitl-gate → execute
 *
 * Post zone (user-configurable, wraps around core):
 *   Applied in config order, each wraps the downstream response
 *
 * Default middlewares (schema-validator, untrusted-envelope, output-injection-detector)
 * are included unless explicitly disabled via `enabled: false`.
 */
export function buildMiddlewareChain(agentConfig: AgentConfig, _deps: MiddlewareDeps): Middleware {
  const userMiddleware = agentConfig.middleware;

  // undefined  → defaults (schema-validator, untrusted-envelope, output-injection-detector)
  // []         → bare pipeline, no middlewares at all
  // [items...] → defaults + user items; use `enabled: false` to disable a default
  let enabledMiddleware: MiddlewareItemConfig[];

  if (userMiddleware === undefined) {
    enabledMiddleware = DEFAULT_MIDDLEWARE;
  } else if (userMiddleware.length === 0) {
    enabledMiddleware = [];
  } else {
    const disabledNames = new Set(
      userMiddleware.filter((m) => m.enabled === false).map((m) => m.name)
    );
    const userNames = new Set(userMiddleware.map((m) => m.name));
    const defaults = DEFAULT_MIDDLEWARE.filter(
      (m) => !disabledNames.has(m.name) && !userNames.has(m.name)
    );
    enabledMiddleware = [...defaults, ...userMiddleware.filter((m) => m.enabled !== false)];
  }

  // Separate core-zone middleware (detectors + schema-validator) from post middlewares
  const coreNames = new Set(['injection-detector', 'sensitivity-classifier', 'schema-validator']);
  const coreUserMiddleware = enabledMiddleware.filter((m) => coreNames.has(m.name));
  const postUserMiddleware = enabledMiddleware.filter((m) => !coreNames.has(m.name));

  // Extract schema-validator separately — it runs before detectors
  const schemaValidators = coreUserMiddleware.filter((m) => m.name === 'schema-validator');
  const detectors = coreUserMiddleware.filter((m) => m.name !== 'schema-validator');

  // Core zone: fixed security-critical order
  //   allowlist → exec-policy → schema-validator → [detectors] → hitl-gate → sandbox → execute
  const coreMiddlewares: Middleware[] = [
    allowlistMiddleware(),
    execPolicyMiddleware(),
    ...schemaValidators.map((m) => withToolFilter(resolveMiddleware(m), m)),
    ...detectors.map((m) => withToolFilter(resolveMiddleware(m), m)),
    hitlGateMiddleware(),
    sandboxMiddleware(),
    executeMiddleware(),
  ];

  // Post zone: user-configurable
  const postMiddlewares: Middleware[] = postUserMiddleware.map((m) =>
    withToolFilter(resolveMiddleware(m), m)
  );

  // Post middlewares wrap the core chain
  // They run after execution (or wrap around it), so they go before core in compose order
  return compose([...postMiddlewares, ...coreMiddlewares]);
}
