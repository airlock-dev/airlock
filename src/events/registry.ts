import { createHash } from 'crypto';
import type { AllowlistEngine, Decision } from '../allowlist/engine.js';
import type { ProviderCatalogSummary } from '../registry/registry.js';
import { sanitizeToolDescription } from '../registry/sanitizer.js';
import { stableStringify } from '../util/stable-json.js';
import { childLogger } from '../util/logger.js';
import { compileEventSchema, type CompiledEventSchema } from './schema-validator.js';
import {
  SUPPORTED_GATEWAY_DELIVERY_MODES,
  namespaceEventName,
  scanXMcpHeaderDeclarations,
  type EventDeliveryMode,
  type EventDescriptor,
} from './protocol.js';

const log = childLogger('events:registry');

export interface EventSourcePool {
  getMcpIds(): string[];
  isReady(mcpId: string): boolean;
  supportsEvents(mcpId: string): boolean;
  listEvents(mcpId: string): Promise<EventDescriptor[]>;
}

export interface RegisteredEvent {
  providerId: string;
  upstreamName: string;
  /** Gateway-namespaced event descriptor (`provider/upstream.name`), webhook stripped. */
  descriptor: EventDescriptor;
  /** Precompiled JSON Schema (2020-12 or draft-07) validator for subscription arguments. */
  validateInput?: CompiledEventSchema;
  /** Precompiled JSON Schema (2020-12 or draft-07) validator for delivered event payloads. */
  validatePayload?: CompiledEventSchema;
}

export interface AgentVisibleEvent {
  event: EventDescriptor;
  providerId: string;
  upstreamName: string;
  decision: Exclude<Decision, 'deny'>;
}

/**
 * Discovers, validates, sanitizes, fingerprints, and policy-filters upstream MCP Events (`events/list`).
 *
 * Mirrors `ToolRegistry` for the SEP-3415 `io.modelcontextprotocol/events` extension:
 * - Only `poll` and `push` delivery modes are advertised (`webhook` is stripped).
 * - Descriptors with invalid `x-mcp-header` annotations or uncompilable JSON Schemas are excluded
 *   with a diagnostic warning at ingestion time.
 * - Notifies `onRefresh` listeners after each committed refresh so active streams can reconcile
 *   against removed events, dropped delivery modes, or breaking schema changes.
 */
export class EventRegistry {
  private cachedEvents: RegisteredEvent[] = [];
  private cachedByName = new Map<string, RegisteredEvent>();
  private cachedCatalogSummary: Record<string, ProviderCatalogSummary> = {};
  private refreshGeneration = 0;
  private refreshListeners = new Set<() => void | Promise<void>>();

  constructor(
    private pool: EventSourcePool,
    private allowlist: AllowlistEngine
  ) {}

  onRefresh(listener: () => void | Promise<void>): () => void {
    this.refreshListeners.add(listener);
    return () => this.refreshListeners.delete(listener);
  }

  async refresh(): Promise<void> {
    const generation = ++this.refreshGeneration;
    const discovered: RegisteredEvent[] = [];

    for (const providerId of this.pool.getMcpIds()) {
      if (!this.pool.isReady(providerId)) continue;
      if (!this.pool.supportsEvents(providerId)) continue;

      try {
        const upstreamEvents = await this.pool.listEvents(providerId);
        for (const raw of upstreamEvents) {
          const delivery = raw.delivery.filter((mode): mode is EventDeliveryMode =>
            SUPPORTED_GATEWAY_DELIVERY_MODES.has(mode)
          );
          if (delivery.length === 0) {
            log.debug(
              { providerId, event: raw.name, upstreamDelivery: raw.delivery },
              'Skipping upstream event with no gateway-supported delivery mode (poll/push)'
            );
            continue;
          }

          const namespacedName = namespaceEventName(providerId, raw.name);

          const headerScan = scanXMcpHeaderDeclarations(raw.inputSchema);
          if (!headerScan.valid) {
            log.warn(
              { providerId, event: namespacedName, reason: headerScan.reason },
              'Excluding upstream event with invalid x-mcp-header declaration'
            );
            continue;
          }

          let validateInput: CompiledEventSchema | undefined;
          if (raw.inputSchema) {
            const compiled = compileEventSchema(raw.inputSchema);
            if (!compiled.ok) {
              log.warn(
                { providerId, event: namespacedName, error: compiled.error },
                'Excluding upstream event with invalid inputSchema'
              );
              continue;
            }
            validateInput = compiled.validate;
          }

          let validatePayload: CompiledEventSchema | undefined;
          if (raw.payloadSchema) {
            const compiled = compileEventSchema(raw.payloadSchema);
            if (!compiled.ok) {
              log.warn(
                { providerId, event: namespacedName, error: compiled.error },
                'Excluding upstream event with invalid payloadSchema'
              );
              continue;
            }
            validatePayload = compiled.validate;
          }

          const sanitizedDescription = raw.description
            ? sanitizeToolDescription(namespacedName, raw.description)
            : undefined;

          discovered.push({
            providerId,
            upstreamName: raw.name,
            descriptor: {
              ...raw,
              name: namespacedName,
              ...(sanitizedDescription !== undefined ? { description: sanitizedDescription } : {}),
              delivery,
            },
            validateInput,
            validatePayload,
          });
        }
      } catch (err) {
        log.warn(
          { err, providerId },
          'Failed to list events from MCP provider; preserving cached descriptors for this provider'
        );
        for (const prev of this.cachedEvents) {
          if (prev.providerId === providerId) {
            discovered.push(prev);
          }
        }
      }
    }

    if (generation !== this.refreshGeneration) return;

    this.cachedEvents = discovered;
    this.cachedByName = new Map(discovered.map((entry) => [entry.descriptor.name, entry]));
    this.cachedCatalogSummary = summarizeEventCatalog(discovered);
    log.info({ count: discovered.length }, 'Event registry refreshed');

    for (const listener of this.refreshListeners) {
      try {
        await listener();
      } catch (err) {
        log.warn({ err }, 'Event registry refresh listener failed');
      }
    }
  }

  getAllEvents(): RegisteredEvent[] {
    return this.cachedEvents;
  }

  getByName(namespacedName: string): RegisteredEvent | undefined {
    return this.cachedByName.get(namespacedName);
  }

  getFilteredWithDecisions(agentId: string): AgentVisibleEvent[] {
    const visible: AgentVisibleEvent[] = [];
    for (const entry of this.cachedEvents) {
      const decision = this.allowlist.evaluateEvent(agentId, entry.descriptor.name);
      if (decision === 'deny') continue;
      visible.push({
        event: entry.descriptor,
        providerId: entry.providerId,
        upstreamName: entry.upstreamName,
        decision,
      });
    }
    return visible;
  }

  getFiltered(agentId: string): EventDescriptor[] {
    return this.getFilteredWithDecisions(agentId).map((entry) => entry.event);
  }

  /** Whether this agent can currently see at least one event type. */
  hasEventsFor(agentId: string): boolean {
    return this.cachedEvents.some(
      (entry) => this.allowlist.evaluateEvent(agentId, entry.descriptor.name) !== 'deny'
    );
  }

  /** Per-provider event contract fingerprints, exposed on `/health` alongside `toolCatalog`. */
  getCatalogSummary(): Record<string, ProviderCatalogSummary> {
    return this.cachedCatalogSummary;
  }
}

function summarizeEventCatalog(events: RegisteredEvent[]): Record<string, ProviderCatalogSummary> {
  const byProvider = new Map<string, EventDescriptor[]>();
  for (const { providerId, descriptor } of events) {
    const bucket = byProvider.get(providerId);
    if (bucket) bucket.push(descriptor);
    else byProvider.set(providerId, [descriptor]);
  }

  const summary: Record<string, ProviderCatalogSummary> = {};
  for (const [providerId, providerEvents] of byProvider) {
    const hash = createHash('sha256');
    for (const event of [...providerEvents].sort((a, b) => a.name.localeCompare(b.name))) {
      hash.update(event.name);
      hash.update('\0');
      hash.update(event.description ?? '');
      hash.update('\0');
      hash.update(stableStringify([...event.delivery].sort()));
      hash.update('\0');
      hash.update(stableStringify(event.inputSchema ?? null));
      hash.update('\0');
      hash.update(stableStringify(event.payloadSchema ?? null));
      hash.update('\0');
    }
    summary[providerId] = {
      count: providerEvents.length,
      fingerprint: `sha256:${hash.digest('hex')}`,
    };
  }
  return summary;
}
