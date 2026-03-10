import { formatBatch } from '../formatter.js';
import type { HitlProvider, HitlNotification, ApprovalApi } from './types.js';
import { childLogger } from '../../util/logger.js';

const log = childLogger('hitl-telegram');

interface TelegramConfig {
  bot_token: string;
  chat_id: string;
}

export class TelegramHitlProvider implements HitlProvider {
  private polling = false;
  private lastUpdateId = 0;
  private pollTimer?: NodeJS.Timeout;

  constructor(
    private config: TelegramConfig,
    private approvalApi: ApprovalApi,
  ) {}

  private get apiBase(): string {
    return `https://api.telegram.org/bot${this.config.bot_token}`;
  }

  async init(): Promise<void> {
    this.polling = true;
    this.schedulePoll();
    log.info({ chat_id: this.config.chat_id }, 'Telegram HITL provider started');
  }

  async notify(requests: HitlNotification[]): Promise<void> {
    const text = formatBatch(requests);
    const res = await fetch(`${this.apiBase}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: this.config.chat_id, text, parse_mode: 'Markdown' }),
    });
    if (!res.ok) {
      log.error({ status: res.status }, 'Failed to send Telegram notification');
    }
  }

  private schedulePoll(): void {
    if (!this.polling) return;
    this.pollTimer = setTimeout(() => this.poll(), 1000);
    this.pollTimer.unref();
  }

  private async poll(): Promise<void> {
    try {
      const res = await fetch(
        `${this.apiBase}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=25&allowed_updates=["message"]`,
      );
      if (!res.ok) throw new Error(`getUpdates failed: ${res.status}`);

      const data = await res.json() as { ok: boolean; result: TelegramUpdate[] };
      if (data.ok && data.result.length > 0) {
        for (const update of data.result) {
          this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
          this.handleMessage(update.message?.text ?? '');
        }
      }
    } catch (err) {
      log.warn({ err }, 'Telegram poll error');
    }
    this.schedulePoll();
  }

  private handleMessage(text: string): void {
    const approveMatch = text.match(/^approve\s+([A-Z0-9]{6})$/i);
    const denyMatch    = text.match(/^deny\s+([A-Z0-9]{6})(?:\s+(.+))?$/i);

    if (approveMatch) {
      log.info({ code: approveMatch[1] }, 'Approve via Telegram');
      this.approvalApi.approve(approveMatch[1]);
    } else if (denyMatch) {
      log.info({ code: denyMatch[1] }, 'Deny via Telegram');
      this.approvalApi.deny(denyMatch[1], denyMatch[2]);
    }
  }

  async stop(): Promise<void> {
    this.polling = false;
    clearTimeout(this.pollTimer);
  }
}

interface TelegramUpdate {
  update_id: number;
  message?: { text?: string };
}
