import { formatBatch } from '../formatter.js';
import { childLogger } from '../../util/logger.js';
import type { HitlProvider, HitlNotification } from './types.js';

const log = childLogger('hitl:webhook');

export interface WebhookHitlConfig {
  url: string;
  headers: Record<string, string>;
}

export class WebhookHitlProvider implements HitlProvider {
  constructor(private cfg: WebhookHitlConfig) {}

  async init(): Promise<void> {}

  async stop(): Promise<void> {}

  async notify(requests: HitlNotification[]): Promise<void> {
    const text = formatBatch(requests);
    const body = JSON.stringify({ requests, text });

    const res = await fetch(this.cfg.url, {
      method: 'POST',
      headers: {
        ...this.cfg.headers,
        'Content-Type': 'application/json',
      },
      body,
    });

    if (!res.ok) {
      log.warn({ status: res.status }, 'Webhook returned non-2xx');
    }
  }
}
