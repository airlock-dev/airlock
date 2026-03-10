import { formatBatch } from '../formatter.js';
import { childLogger } from '../../util/logger.js';
import type { HitlProvider, HitlNotification } from './types.js';

const log = childLogger('hitl-slack');

export interface SlackHitlConfig {
  webhook_url: string;
}

export class SlackHitlProvider implements HitlProvider {
  constructor(private cfg: SlackHitlConfig) {}

  async init(): Promise<void> {}

  async stop(): Promise<void> {}

  async notify(requests: HitlNotification[]): Promise<void> {
    const text = formatBatch(requests);
    const body = JSON.stringify({ text });

    const res = await fetch(this.cfg.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (!res.ok) {
      log.warn({ status: res.status }, 'Slack webhook returned non-2xx');
    }
  }
}
