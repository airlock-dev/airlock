import type { AgentConfig, MiddlewareItemConfig } from '../config/schema.js';
import type { AuditLogger } from '../audit/logger.js';
import { matches } from '../allowlist/pattern.js';
import { childLogger } from '../util/logger.js';
import type { CompiledEventSchema } from './schema-validator.js';
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

/**
 * Only protocol-reserved upstream metadata namespaces pass through on `EventOccurrence._meta`.
 * `dev.airlock/*` is strictly gateway-owned and NEVER accepted from upstream servers.
 */
const SAFE_UPSTREAM_META_PREFIXES = ['io.modelcontextprotocol/'];

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

const MAX_PAYLOAD_DEPTH = 64;

function textHasInjection(text: string): boolean {
  return EVENT_INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

function transformPayloadValue(
  value: unknown,
  cfg: EffectiveEventPostConfig,
  state: { injectionDetected: boolean; modified: boolean },
  depth = 0
): unknown {
  if (depth >= MAX_PAYLOAD_DEPTH) {
    return value;
  }
  if (typeof value === 'string') {
    let next = value;

    if (cfg.stripQueryParams) {
      const stripped = next.replace(URL_WITH_QUERY_REGEX, '$1');
      if (stripped !== next) state.modified = true;
      next = stripped;
    }

    if (cfg.injectionEnabled) {
      for (const pattern of EVENT_INJECTION_PATTERNS) {
        if (pattern.test(next)) {
          state.injectionDetected = true;
          if (cfg.injectionMode === 'mangle') {
            const mangled = next.replace(
              new RegExp(pattern.source, pattern.flags + (pattern.flags.includes('g') ? '' : 'g')),
              '[REDACTED: suspected injection]'
            );
            if (mangled !== next) state.modified = true;
            next = mangled;
          }
        }
      }
    }

    if (cfg.maxStringChars !== undefined && next.length > cfg.maxStringChars) {
      next = `${next.slice(0, cfg.maxStringChars)}… [truncated by Airlock]`;
      state.modified = true;
    }

    return next;
  }

  if (Array.isArray(value)) {
    return value.map((item) => transformPayloadValue(item, cfg, state, depth + 1));
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (cfg.injectionEnabled && textHasInjection(k)) {
        state.injectionDetected = true;
      }
      out[k] = transformPayloadValue(v, cfg, state, depth + 1);
    }
    return out;
  }

  return value;
}

function scanForInjection(value: unknown, state: { injectionDetected: boolean }, depth = 0): void {
  if (depth >= MAX_PAYLOAD_DEPTH) return;
  if (typeof value === 'string') {
    if (textHasInjection(value)) state.injectionDetected = true;
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) scanForInjection(item, state, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (textHasInjection(k)) state.injectionDetected = true;
      scanForInjection(v, state, depth + 1);
    }
  }
}

function filterOccurrenceMeta(
  rawMeta: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!rawMeta) return {};
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawMeta)) {
    if (SAFE_UPSTREAM_META_PREFIXES.some((prefix) => k.startsWith(prefix))) {
      filtered[k] = v;
    }
  }
  return filtered;
}

export interface InspectEventOccurrenceParams {
  agentId: string;
  agentConfig: AgentConfig;
  namespacedEventName: string;
  occurrence: EventOccurrence;
  auditLogger: AuditLogger;
  requestId: string;
  /** Optional precompiled `payloadSchema` validator so transforms never break the advertised contract. */
  validatePayload?: CompiledEventSchema;
}

/**
 * Inspect and sanitize an upstream `EventOccurrence` before delivering it to an agent.
 *
 * - Strips unknown pass-through top-level fields and untrusted upstream `_meta` entries.
 * - Inspects both property keys and string values in `data` for prompt injection.
 * - Verifies transformed `data` against `payloadSchema` (when available) so mangling or truncation
 *   never silently emits a schema-invalid payload; falls back to the valid original value while
 *   keeping `dev.airlock/injectionDetected` and audit logging intact.
 */
export function inspectEventOccurrence(params: InspectEventOccurrenceParams): EventOccurrence {
  const {
    agentId,
    agentConfig,
    namespacedEventName,
    occurrence,
    auditLogger,
    requestId,
    validatePayload,
  } = params;
  const cfg = resolveEventPostConfig(agentConfig, namespacedEventName);
  const state = { injectionDetected: false, modified: false };

  let deliveredData = transformPayloadValue(occurrence.data, cfg, state) as Record<string, unknown>;
  const filteredUpstreamMeta = filterOccurrenceMeta(occurrence._meta);

  if (cfg.injectionEnabled) {
    if (textHasInjection(occurrence.eventId) || textHasInjection(occurrence.timestamp)) {
      state.injectionDetected = true;
    }
    scanForInjection(filteredUpstreamMeta, state);
  }

  if (state.modified && validatePayload) {
    const originalValid = Boolean(validatePayload(occurrence.data));
    const transformedValid = Boolean(validatePayload(deliveredData));
    if (originalValid && !transformedValid) {
      log.warn(
        { agentId, event: namespacedEventName, eventId: occurrence.eventId },
        'Event payload transform violated payloadSchema; preserving schema-valid data and flagging metadata'
      );
      deliveredData = occurrence.data;
    }
  }

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
    ...filteredUpstreamMeta,
    ...(cfg.markUntrusted ? { [AIRLOCK_UNTRUSTED_META_KEY]: true } : {}),
    ...(state.injectionDetected ? { [AIRLOCK_INJECTION_DETECTED_META_KEY]: true } : {}),
  };

  return {
    eventId: occurrence.eventId,
    name: namespacedEventName,
    timestamp: occurrence.timestamp,
    data: deliveredData,
    ...(occurrence.cursor !== undefined ? { cursor: occurrence.cursor } : {}),
    ...(Object.keys(nextMeta).length > 0 ? { _meta: nextMeta } : {}),
  };
}
