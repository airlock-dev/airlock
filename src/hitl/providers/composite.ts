import type { AirlockActivityEvent } from '../../activity/stream.js';
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

  async updateBadge(badgeCount: number): Promise<void> {
    await Promise.allSettled(
      this.providers.flatMap((p) => (p.updateBadge ? [p.updateBadge(badgeCount)] : []))
    );
  }

  async updateApprovalStatus(status: {
    id: string;
    code: string;
    result: 'approved' | 'denied' | 'timeout' | 'cancelled';
    badgeCount: number;
  }): Promise<void> {
    await Promise.allSettled(
      this.providers.flatMap((p) =>
        p.updateApprovalStatus ? [p.updateApprovalStatus(status)] : []
      )
    );
  }

  async notifyActivity(event: AirlockActivityEvent): Promise<void> {
    const results = await Promise.allSettled(
      this.providers.flatMap((p) => (p.notifyActivity ? [p.notifyActivity(event)] : []))
    );
    for (const r of results) {
      if (r.status === 'rejected') {
        log.error({ err: r.reason }, 'HITL provider activity notification failed');
      }
    }
  }

  async stop(): Promise<void> {
    await Promise.allSettled(this.providers.map((p) => p.stop()));
  }
}
