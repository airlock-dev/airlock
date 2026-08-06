import type { HitlNotification } from './providers/types.js';
import { childLogger } from '../util/logger.js';

const log = childLogger('hitl-batcher');

interface Batch {
  requests: HitlNotification[];
  timer: NodeJS.Timeout;
}

export class HitlBatcher {
  private batches = new Map<string, Batch>(); // agentId → batch
  private onBatchReadyCallback?: (agentId: string, requests: HitlNotification[]) => void;

  constructor(private windowMs: number) {}

  onBatchReady(cb: (agentId: string, requests: HitlNotification[]) => void): void {
    this.onBatchReadyCallback = cb;
  }

  add(request: HitlNotification): void {
    const { agentId } = request;
    const existing = this.batches.get(agentId);

    if (existing) {
      existing.requests.push(request);
      log.debug({ agentId, batchSize: existing.requests.length }, 'Added to existing batch');
    } else {
      const timer = setTimeout(() => this.flush(agentId), this.windowMs);
      timer.unref();
      this.batches.set(agentId, { requests: [request], timer });
      log.debug({ agentId }, 'Started new batch window');
    }
  }

  /** Remove a request that was cancelled before its notification batch was dispatched. */
  remove(id: string): boolean {
    for (const [agentId, batch] of this.batches) {
      const index = batch.requests.findIndex((request) => request.id === id);
      if (index === -1) continue;

      batch.requests.splice(index, 1);
      if (batch.requests.length === 0) {
        clearTimeout(batch.timer);
        this.batches.delete(agentId);
      }
      log.debug({ agentId, id }, 'Removed cancelled request from notification batch');
      return true;
    }
    return false;
  }

  private flush(agentId: string): void {
    const batch = this.batches.get(agentId);
    if (!batch) return;
    this.batches.delete(agentId);
    clearTimeout(batch.timer);
    log.info({ agentId, count: batch.requests.length }, 'Batch window closed, firing');
    this.onBatchReadyCallback?.(agentId, batch.requests);
  }
}
