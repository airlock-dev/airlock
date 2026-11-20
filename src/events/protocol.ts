import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { z } from 'zod';

/** Official MCP Events extension identifier (SEP-3415). */
export const EVENTS_EXTENSION_ID = 'io.modelcontextprotocol/events';

/** Core MCP correlation key on `notifications/events/*` params._meta. */
export const SUBSCRIPTION_ID_META_KEY = 'io.modelcontextprotocol/subscriptionId';

/** Airlock provenance metadata keys attached to delivered EventOccurrence._meta. */
export const AIRLOCK_UNTRUSTED_META_KEY = 'dev.airlock/untrusted';
export const AIRLOCK_INJECTION_DETECTED_META_KEY = 'dev.airlock/injectionDetected';

/** SEP-3415 / SEP-2243 JSON-RPC error codes. */
export const EVENTS_ERROR_CODES = {
  InvalidParams: ProtocolErrorCode.InvalidParams, // -32602
  HeaderMismatch: -32020,
  NotFound: -32023,
  Forbidden: -32024,
  ResourceExhausted: -32025,
  Unsupported: -32026,
  CallbackEndpointError: -32027,
} as const;

export type EventsErrorCode = (typeof EVENTS_ERROR_CODES)[keyof typeof EVENTS_ERROR_CODES];

export const EventDeliveryModeSchema = z.enum(['poll', 'push', 'webhook']);
export type EventDeliveryMode = z.infer<typeof EventDeliveryModeSchema>;

/** Delivery modes Airlock currently proxies end-to-end without bypassing inspection/revocation. */
export const SUPPORTED_GATEWAY_DELIVERY_MODES = new Set<EventDeliveryMode>(['poll', 'push']);

export const EventDescriptorSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    delivery: z.array(EventDeliveryModeSchema).min(1),
    inputSchema: z.record(z.string(), z.unknown()).optional(),
    payloadSchema: z.record(z.string(), z.unknown()).optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type EventDescriptor = z.infer<typeof EventDescriptorSchema>;

export const EventOccurrenceSchema = z
  .object({
    eventId: z.string(),
    name: z.string(),
    timestamp: z.string(),
    data: z.record(z.string(), z.unknown()),
    cursor: z.string().nullable().optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type EventOccurrence = z.infer<typeof EventOccurrenceSchema>;

export const EventsListParamsSchema = z
  .object({
    cursor: z.string().optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type EventsListParams = z.infer<typeof EventsListParamsSchema>;

export const EventsListResultSchema = z
  .object({
    resultType: z.literal('complete').optional(),
    events: z.array(EventDescriptorSchema),
    nextCursor: z.string().optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type EventsListResult = z.infer<typeof EventsListResultSchema>;

export const EventsPollParamsSchema = z
  .object({
    name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).optional(),
    cursor: z.string().nullable().optional(),
    maxAgeMs: z.number().int().nonnegative().optional(),
    maxEvents: z.number().int().positive().optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type EventsPollParams = z.infer<typeof EventsPollParamsSchema>;

export const EventsPollResultSchema = z
  .object({
    resultType: z.literal('complete').optional(),
    events: z.array(EventOccurrenceSchema),
    cursor: z.string().nullable().optional(),
    truncated: z.boolean().optional(),
    hasMore: z.boolean().optional(),
    nextPollMs: z.number().int().nonnegative().optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type EventsPollResult = z.infer<typeof EventsPollResultSchema>;

export const EventsStreamParamsSchema = z
  .object({
    name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).optional(),
    cursor: z.string().nullable().optional(),
    maxAgeMs: z.number().int().nonnegative().optional(),
    heartbeatMs: z.number().int().positive().optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type EventsStreamParams = z.infer<typeof EventsStreamParamsSchema>;

export const EventsStreamResultSchema = z
  .object({
    resultType: z.literal('complete').optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type EventsStreamResult = z.infer<typeof EventsStreamResultSchema>;

export const EventsSubscribeParamsSchema = z
  .object({
    name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).optional(),
    delivery: z.record(z.string(), z.unknown()).optional(),
    cursor: z.string().nullable().optional(),
    maxAgeMs: z.number().int().nonnegative().optional(),
    ttlMs: z.number().int().positive().nullable().optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const EventsUnsubscribeParamsSchema = z
  .object({
    name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).optional(),
    delivery: z.record(z.string(), z.unknown()).optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const EventStreamErrorObjectSchema = z
  .object({
    code: z.number().int(),
    message: z.string(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type EventStreamErrorObject = z.infer<typeof EventStreamErrorObjectSchema>;

export const EventStreamActiveParamsSchema = z
  .object({
    cursor: z.string().nullable().optional(),
    truncated: z.boolean().optional(),
    heartbeatMs: z.number().int().positive().optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type EventStreamActiveParams = z.infer<typeof EventStreamActiveParamsSchema>;

export const EventStreamHeartbeatParamsSchema = z
  .object({
    cursor: z.string().nullable().optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type EventStreamHeartbeatParams = z.infer<typeof EventStreamHeartbeatParamsSchema>;

export const EventStreamErrorParamsSchema = z
  .object({
    error: EventStreamErrorObjectSchema,
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type EventStreamErrorParams = z.infer<typeof EventStreamErrorParamsSchema>;

export const EventStreamTerminatedParamsSchema = EventStreamErrorParamsSchema;
export type EventStreamTerminatedParams = EventStreamErrorParams;

export const EVENT_METHODS = {
  list: 'events/list',
  poll: 'events/poll',
  stream: 'events/stream',
  subscribe: 'events/subscribe',
  unsubscribe: 'events/unsubscribe',
} as const;

export const EVENT_NOTIFICATIONS = {
  active: 'notifications/events/active',
  event: 'notifications/events/event',
  heartbeat: 'notifications/events/heartbeat',
  error: 'notifications/events/error',
  terminated: 'notifications/events/terminated',
  listChanged: 'notifications/events/list_changed',
} as const;

export function createEventsError(
  code: number,
  message: string,
  data?: Record<string, unknown>
): ProtocolError {
  return ProtocolError.fromError(code, message, data);
}

/** Namespace an upstream event name under its Airlock provider ID (`provider/event.name`). */
export function namespaceEventName(providerId: string, upstreamName: string): string {
  return `${providerId}/${upstreamName}`;
}

/** Split an Airlock-namespaced event name (`provider/event.name`) into provider ID + upstream name. */
export function splitEventName(
  namespacedName: string
): { providerId: string; upstreamName: string } | undefined {
  const idx = namespacedName.indexOf('/');
  if (idx <= 0 || idx === namespacedName.length - 1) return undefined;
  return {
    providerId: namespacedName.slice(0, idx),
    upstreamName: namespacedName.slice(idx + 1),
  };
}

const PLAIN_ASCII_HEADER = /^[\x21-\x7e]+$/;
const BASE64_SENTINEL = /^=\?base64\?([A-Za-z0-9+/=]+)\?=$/;

/** Encode a header value per SEP-2243 (plain visible ASCII or Base64 sentinel). */
export function encodeMcpHeaderValue(value: string): string {
  if (PLAIN_ASCII_HEADER.test(value) && !value.startsWith('=?base64?')) {
    return value;
  }
  return `=?base64?${Buffer.from(value, 'utf-8').toString('base64')}?=`;
}

/** Decode a SEP-2243 header value (plain ASCII or `=?base64?...?=`). Returns undefined if malformed. */
export function decodeMcpHeaderValue(header: string): string | undefined {
  const trimmed = header.trim();
  if (!trimmed.startsWith('=?base64?')) {
    return trimmed;
  }
  const match = BASE64_SENTINEL.exec(trimmed);
  if (!match) return undefined;
  const raw = match[1];
  if (raw.length % 4 !== 0) return undefined;
  const decoded = Buffer.from(raw, 'base64');
  // Reject non-canonical base64 payloads.
  if (decoded.toString('base64') !== raw) return undefined;
  return decoded.toString('utf-8');
}

/**
 * Extract `x-mcp-header` property declarations from an event's `inputSchema`.
 * Returns entries of `[argName, headerSuffix]` (for `Mcp-Param-${headerSuffix}`).
 */
export function extractXMcpHeaders(
  inputSchema?: Record<string, unknown>
): Array<{ argName: string; headerName: string }> {
  const properties = inputSchema?.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return [];

  const result: Array<{ argName: string; headerName: string }> = [];
  for (const [argName, prop] of Object.entries(properties as Record<string, unknown>)) {
    if (!prop || typeof prop !== 'object' || Array.isArray(prop)) continue;
    const headerSuffix = (prop as Record<string, unknown>)['x-mcp-header'];
    if (typeof headerSuffix === 'string' && /^[A-Za-z0-9-]+$/.test(headerSuffix)) {
      result.push({ argName, headerName: `Mcp-Param-${headerSuffix}` });
    }
  }
  return result;
}

/**
 * Validate `Mcp-Name` and `Mcp-Param-*` routing headers when present on a Streamable HTTP request.
 * Throws `-32020 HeaderMismatch` on invalid encoding or header/body disagreement per SEP-3415.
 */
export function validateEventRoutingHeaders(
  httpReq: Request | undefined,
  eventName: string,
  args: Record<string, unknown>,
  inputSchema?: Record<string, unknown>
): void {
  if (!httpReq) return;

  const mcpName = httpReq.headers.get('mcp-name');
  if (mcpName !== null) {
    const decoded = decodeMcpHeaderValue(mcpName);
    if (decoded === undefined) {
      throw createEventsError(
        EVENTS_ERROR_CODES.HeaderMismatch,
        'HeaderMismatch: Mcp-Name carries an invalid Base64 sentinel value'
      );
    }
    if (decoded !== eventName) {
      throw createEventsError(
        EVENTS_ERROR_CODES.HeaderMismatch,
        `HeaderMismatch: Mcp-Name "${decoded}" does not match params.name "${eventName}"`
      );
    }
  }

  for (const { argName, headerName } of extractXMcpHeaders(inputSchema)) {
    const headerVal = httpReq.headers.get(headerName);
    if (headerVal === null) continue;
    const decoded = decodeMcpHeaderValue(headerVal);
    if (decoded === undefined) {
      throw createEventsError(
        EVENTS_ERROR_CODES.HeaderMismatch,
        `HeaderMismatch: ${headerName} carries an invalid Base64 sentinel value`
      );
    }
    const argVal = args[argName];
    const expected =
      argVal === undefined || argVal === null
        ? undefined
        : typeof argVal === 'string'
          ? argVal
          : JSON.stringify(argVal);
    if (expected === undefined || decoded !== expected) {
      throw createEventsError(
        EVENTS_ERROR_CODES.HeaderMismatch,
        `HeaderMismatch: ${headerName} does not match params.arguments.${argName}`
      );
    }
  }
}

/** Build `Mcp-Param-*` headers for an outbound upstream event request. */
export function buildEventParamHeaders(
  args: Record<string, unknown> | undefined,
  inputSchema?: Record<string, unknown>
): Record<string, string> {
  if (!args) return {};
  const headers: Record<string, string> = {};
  for (const { argName, headerName } of extractXMcpHeaders(inputSchema)) {
    const value = args[argName];
    if (value === undefined || value === null) continue;
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    if (str !== undefined) {
      headers[headerName] = encodeMcpHeaderValue(str);
    }
  }
  return headers;
}
