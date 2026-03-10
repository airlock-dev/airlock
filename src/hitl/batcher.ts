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

  private flush(agentId: string): void {
    const batch = this.batches.get(agentId);
    if (!batch) return;
    this.batches.delete(agentId);
    clearTimeout(batch.timer);
    log.info({ agentId, count: batch.requests.length }, 'Batch window closed, firing');
    this.onBatchReadyCallback?.(agentId, batch.requests);
  }
}
