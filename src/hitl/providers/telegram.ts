import { formatBatch } from '../formatter.js';
import { parseApprovalCommand } from '../parser.js';
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
    private approvalApi: ApprovalApi
  ) {}

  private get apiBase(): string {
    return `https://api.telegram.org/bot${this.config.bot_token}`;
  }

  init(): Promise<void> {
    this.polling = true;
    this.schedulePoll();
    log.info({ chat_id: this.config.chat_id }, 'Telegram HITL provider started');
    return Promise.resolve();
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
    this.pollTimer = setTimeout(() => {
      void this.poll();
    }, 1000);
    this.pollTimer.unref();
  }

  private async poll(): Promise<void> {
    try {
      const res = await fetch(
        `${this.apiBase}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=25&allowed_updates=["message"]`
      );
      if (!res.ok) throw new Error(`getUpdates failed: ${res.status}`);

      const data = (await res.json()) as { ok: boolean; result: TelegramUpdate[] };
      if (data.ok && data.result.length > 0) {
        for (const update of data.result) {
          this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
          this.handleUpdate(update);
        }
      }
    } catch (err) {
      log.warn({ err }, 'Telegram poll error');
    }
    this.schedulePoll();
  }

  private handleUpdate(update: TelegramUpdate): void {
    const chatId = update.message?.chat?.id;
    const text = update.message?.text ?? '';

    // Only process messages from the configured chat
    if (!chatId || String(chatId) !== this.config.chat_id) {
      log.warn(
        { chatId, expected: this.config.chat_id },
        'Ignoring message from unauthorized chat'
      );
      return;
    }

    const parsed = parseApprovalCommand(text);
    if (!parsed) return;

    if (parsed.type === 'approve') {
      log.info({ code: parsed.code }, 'Approve via Telegram');
      this.approvalApi.approveByCode(parsed.code);
    } else {
      log.info({ code: parsed.code }, 'Deny via Telegram');
      this.approvalApi.denyByCode(parsed.code, parsed.reason);
    }
  }

  stop(): Promise<void> {
    this.polling = false;
    clearTimeout(this.pollTimer);
    return Promise.resolve();
  }
}

interface TelegramUpdate {
  update_id: number;
  message?: { text?: string; chat?: { id: number } };
}
