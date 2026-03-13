import type { HitlProvider, HitlNotification } from './types.js';
import { childLogger } from '../../util/logger.js';

const log = childLogger('hitl-composite');

export class CompositeHitlProvider implements HitlProvider {
  constructor(private providers: HitlProvider[]) {}

  async init(): Promise<void> {
    await Promise.all(this.providers.map((p) => p.init()));
  }

  async notify(requests: HitlNotification[]): Promise<void> {
    const results = await Promise.allSettled(this.providers.map((p) => p.notify(requests)));
    for (const r of results) {
      if (r.status === 'rejected') {
        log.error({ err: r.reason }, 'HITL provider notify failed');
      }
    }
  }

  async stop(): Promise<void> {
    await Promise.allSettled(this.providers.map((p) => p.stop()));
  }
}
