import type { AgentConfig, MiddlewareItemConfig } from '../config/schema.js';
import type { AuditLogger } from '../audit/logger.js';
import { matches } from '../allowlist/pattern.js';
import { childLogger } from '../util/logger.js';
import {
  AIRLOCK_INJECTION_DETECTED_META_KEY,
  AIRLOCK_UNTRUSTED_META_KEY,
  type EventOccurrence,
} from './protocol.js';

const log = childLogger('events:inspector');

const EVENT_INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /ignore\s+(all\s+)?prior\s+instructions/i,
  /disregard\s+(all\s+)?previous/i,
  /you\s+are\s+now\s+(a|an)\s/i,
  /new\s+instructions?\s*:/i,
  /system\s*:\s/i,
  /<\s*system\s*>/i,
  /\[INST\]/i,
  /\[\/INST\]/i,
  /<<\s*SYS\s*>>/i,
  /\bAssistant:\s/i,
  /\bHuman:\s/i,
  /\bUser:\s/i,
  /do\s+not\s+follow\s+(any\s+)?previous/i,
  /forget\s+(all\s+)?(your\s+)?instructions/i,
  /override\s+(all\s+)?instructions/i,
];

const URL_WITH_QUERY_REGEX = /(https?:\/\/[^\s"'<>)\]]+)\?([^\s"'<>)\]]+)/g;

interface EffectiveEventPostConfig {
  injectionEnabled: boolean;
  injectionMode: 'detect' | 'mangle';
  stripQueryParams: boolean;
  maxStringChars?: number;
  markUntrusted: boolean;
}

function appliesToEvent(eventName: string, item: MiddlewareItemConfig): boolean {
  if (item.exclude?.some((p) => matches(p, eventName))) return false;
  if (item.tools && !item.tools.some((p) => matches(p, eventName))) return false;
  return true;
}

function resolveEventPostConfig(
  agentConfig: AgentConfig,
  eventName: string
): EffectiveEventPostConfig {
  const userMiddleware = agentConfig.middleware;

  // Match buildMiddlewareChain's exact default semantics:
  //   undefined  → defaults (untrusted-envelope + output-injection-detector in detect mode)
  //   []         → bare pipeline, no defaults
  //   [items...] → defaults unless explicitly disabled via enabled: false
  if (userMiddleware && userMiddleware.length === 0) {
    return {
      injectionEnabled: false,
      injectionMode: 'detect',
      stripQueryParams: false,
      markUntrusted: false,
    };
  }

  const findItem = (name: MiddlewareItemConfig['name']) =>
    userMiddleware?.find((m) => m.name === name);

  const injectionItem = findItem('output-injection-detector');
  const injectionEnabled =
    injectionItem === undefined
      ? true
      : injectionItem.enabled !== false && appliesToEvent(eventName, injectionItem);
  const injectionMode: 'detect' | 'mangle' = injectionItem?.mode === 'mangle' ? 'mangle' : 'detect';

  const untrustedItem = findItem('untrusted-envelope');
  const markUntrusted =
    untrustedItem === undefined
      ? true
      : untrustedItem.enabled !== false && appliesToEvent(eventName, untrustedItem);

  const stripItem = findItem('strip-query-params');
  const stripQueryParams = Boolean(
    stripItem && stripItem.enabled !== false && appliesToEvent(eventName, stripItem)
  );

  const sizeItem = findItem('output-size-limiter');
  const maxStringChars =
    sizeItem && sizeItem.enabled !== false && appliesToEvent(eventName, sizeItem)
      ? (sizeItem.max_chars ?? 30_000)
      : undefined;

  return {
    injectionEnabled,
    injectionMode,
    stripQueryParams,
    maxStringChars,
    markUntrusted,
  };
}

function transformPayloadValue(
  value: unknown,
  cfg: EffectiveEventPostConfig,
  state: { injectionDetected: boolean }
): unknown {
  if (typeof value === 'string') {
    let next = value;

    if (cfg.stripQueryParams) {
      next = next.replace(URL_WITH_QUERY_REGEX, '$1');
    }

    if (cfg.injectionEnabled) {
      for (const pattern of EVENT_INJECTION_PATTERNS) {
        if (pattern.test(next)) {
          state.injectionDetected = true;
          if (cfg.injectionMode === 'mangle') {
            next = next.replace(
              new RegExp(pattern.source, pattern.flags + (pattern.flags.includes('g') ? '' : 'g')),
              '[REDACTED: suspected injection]'
            );
          }
        }
      }
    }

    if (cfg.maxStringChars !== undefined && next.length > cfg.maxStringChars) {
      next = `${next.slice(0, cfg.maxStringChars)}… [truncated by Airlock]`;
    }

    return next;
  }

  if (Array.isArray(value)) {
    return value.map((item) => transformPayloadValue(item, cfg, state));
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = transformPayloadValue(v, cfg, state);
    }
    return out;
  }

  return value;
}

export interface InspectEventOccurrenceParams {
  agentId: string;
  agentConfig: AgentConfig;
  namespacedEventName: string;
  occurrence: EventOccurrence;
  auditLogger: AuditLogger;
  requestId: string;
}

/**
 * Inspect and sanitize an upstream `EventOccurrence` before delivering it to an agent.
 *
 * Preserves the JSON object structure of `occurrence.data` so it remains conformant with the event
 * type's `payloadSchema`, while applying Airlock's prompt-injection detection/mangling, URL query
 * stripping, string size capping, audit logging, and untrusted-provenance `_meta` stamping.
 */
export function inspectEventOccurrence(params: InspectEventOccurrenceParams): EventOccurrence {
  const { agentId, agentConfig, namespacedEventName, occurrence, auditLogger, requestId } = params;
  const cfg = resolveEventPostConfig(agentConfig, namespacedEventName);
  const state = { injectionDetected: false };

  const inspectedData = transformPayloadValue(occurrence.data, cfg, state) as Record<
    string,
    unknown
  >;

  if (state.injectionDetected) {
    log.warn(
      {
        agentId,
        event: namespacedEventName,
        eventId: occurrence.eventId,
        mode: cfg.injectionMode,
      },
      'Injection pattern detected in upstream event payload'
    );
    auditLogger.log({
      agent_id: agentId,
      request_id: requestId,
      tool: `event:${namespacedEventName}`,
      args: JSON.stringify({ eventId: occurrence.eventId }),
      result: 'injection_detected',
    });
  }

  const nextMeta: Record<string, unknown> = {
    ...(occurrence._meta ?? {}),
    ...(cfg.markUntrusted ? { [AIRLOCK_UNTRUSTED_META_KEY]: true } : {}),
    ...(state.injectionDetected ? { [AIRLOCK_INJECTION_DETECTED_META_KEY]: true } : {}),
  };

  return {
    ...occurrence,
    name: namespacedEventName,
    data: inspectedData,
    ...(Object.keys(nextMeta).length > 0 ? { _meta: nextMeta } : {}),
  };
}
