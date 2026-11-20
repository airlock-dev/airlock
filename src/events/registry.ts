import { createHash } from 'crypto';
import type { AllowlistEngine, Decision } from '../allowlist/engine.js';
import type { ProviderCatalogSummary } from '../registry/registry.js';
import { sanitizeToolDescription } from '../registry/sanitizer.js';
import { stableStringify } from '../util/stable-json.js';
import { childLogger } from '../util/logger.js';
import {
  SUPPORTED_GATEWAY_DELIVERY_MODES,
  namespaceEventName,
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
}

export interface AgentVisibleEvent {
  event: EventDescriptor;
  providerId: string;
  upstreamName: string;
  decision: Exclude<Decision, 'deny'>;
}

/**
 * Discovers, sanitizes, fingerprints, and policy-filters upstream MCP Events (`events/list`).
 *
 * Mirrors `ToolRegistry` for the SEP-3415 `io.modelcontextprotocol/events` extension.
 * Only `poll` and `push` delivery modes are advertised through Airlock; `webhook` is stripped so
 * upstream servers cannot POST directly to external URLs and bypass Airlock's inspection, audit,
 * and revocation controls.
 */
export class EventRegistry {
  private cachedEvents: RegisteredEvent[] = [];
  private cachedByName = new Map<string, RegisteredEvent>();
  private cachedCatalogSummary: Record<string, ProviderCatalogSummary> = {};
  private refreshGeneration = 0;

  constructor(
    private pool: EventSourcePool,
    private allowlist: AllowlistEngine
  ) {}

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
          });
        }
      } catch (err) {
        log.warn({ err, providerId }, 'Failed to list events from MCP provider');
      }
    }

    if (generation !== this.refreshGeneration) return;

    this.cachedEvents = discovered;
    this.cachedByName = new Map(discovered.map((entry) => [entry.descriptor.name, entry]));
    this.cachedCatalogSummary = summarizeEventCatalog(discovered);
    log.info({ count: discovered.length }, 'Event registry refreshed');
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
