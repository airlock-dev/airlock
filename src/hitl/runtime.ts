import type { Config } from '../config/loader.js';
import type { AuditLogger } from '../audit/logger.js';
import { bestSpecificity } from '../allowlist/pattern.js';
import { childLogger } from '../util/logger.js';
import type { HitlBatcher } from './batcher.js';
import type { HitlEngine, HitlEngineOptions } from './engine.js';
import { GrantStore } from './grants.js';
import type { HitlProvider } from './providers/types.js';

const log = childLogger('hitl-runtime');

/** Shared wiring for the gateway and stdio mode. */

/** Whether a (resolved) profile lists the tool under allow/ask and doesn't deny it more specifically. */
export function profileCoversTool(config: Config, profile: string, tool: string): boolean {
  const resolved = config.profiles?.[profile];
  if (!resolved) return false;
  const positive = bestSpecificity([...resolved.allow, ...resolved.ask], tool);
  return positive >= 0 && positive > bestSpecificity(resolved.deny, tool);
}

export function profilesForTool(config: Config, tool: string): string[] {
  return Object.keys(config.profiles ?? {})
    .filter((profile) => profileCoversTool(config, profile, tool))
    .sort();
}

export function createGrantStore(auditLogger: AuditLogger, getConfig: () => Config): GrantStore {
  return new GrantStore(auditLogger, {
    profileCovers: (profile, tool) => profileCoversTool(getConfig(), profile, tool),
  });
}

export function engineOptionsFromConfig(
  config: Config,
  getConfig: () => Config
): Omit<HitlEngineOptions, 'grants'> {
  // Optional chaining tolerates hand-built configs (tests, embedders) that skipped schema defaults.
  const grants = config.approvals.grants as Config['approvals']['grants'] | undefined;
  return {
    defaultMode: config.approvals.mode ?? 'sync',
    asyncGrantTtlMs: grants?.async_ttl_ms,
    planGrantTtlMs: grants?.plan_ttl_ms,
    defaultGrantDurationMs: grants?.default_duration_ms,
    maxGrantDurationMs: grants?.max_duration_ms,
    profilesForTool: (tool) => profilesForTool(getConfig(), tool),
  };
}

/**
 * Batcher → provider. Requests that land in the same window are snapshotted as a batch, so every
 * channel can offer "approve all" for exactly what the operator was shown.
 */
export function wireBatcher(
  batcher: HitlBatcher,
  engine: HitlEngine,
  provider: HitlProvider
): void {
  batcher.onBatchReady((_agentId, requests) => {
    const batch = engine.registerBatch(requests.map((request) => request.id));
    const badgeCount = engine.getPending().length;
    void provider
      .notify(
        requests.map((request) => ({
          ...request,
          badgeCount,
          ...(batch
            ? { batchId: batch.batchId, batchCode: batch.batchCode, batchSize: requests.length }
            : {}),
        }))
      )
      .catch((err) => log.error({ err }, 'Failed to send approval notifications'));
  });
}
