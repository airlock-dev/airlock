import { WebSocket } from 'ws';
import { formatBatch } from '../formatter.js';
import { parseApprovalCommand } from '../parser.js';
import { generateId } from '../../util/id.js';
import type { HitlProvider, HitlNotification, ApprovalApi } from './types.js';
import { childLogger } from '../../util/logger.js';

const log = childLogger('hitl-openclaw');

interface OpenClawConfig {
  gateway_url: string;
  token: string;
  session_key: string;
}

export class OpenClawHitlProvider implements HitlProvider {
  private ws?: InstanceType<typeof WebSocket>;
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private config: OpenClawConfig,
    private approvalApi: ApprovalApi
  ) {}

  async init(): Promise<void> {
    await this.connect();
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.config.gateway_url, {
        headers: { Authorization: `Bearer ${this.config.token}` },
      });

      ws.once('open', () => {
        log.info({ url: this.config.gateway_url }, 'OpenClaw WS connected');
        this.ws = ws;
        resolve();
      });

      ws.once('error', (err: Error) => {
        log.error({ err }, 'OpenClaw WS connection error');
        reject(err);
      });

      ws.on('message', (data: Buffer | string) => {
        try {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>;
          this.handleMessage(msg);
        } catch {
          // ignore non-JSON
        }
      });

      ws.on('close', () => {
        if (!this.stopped) {
          log.warn('OpenClaw WS disconnected, reconnecting in 5s');
          this.reconnectTimer = setTimeout(() => {
            void this.connect().catch(() => {});
          }, 5000);
          this.reconnectTimer.unref();
        }
      });
    });
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const text = extractText(msg);
    if (!text) return;

    const parsed = parseApprovalCommand(text);
    if (!parsed) return;

    if (parsed.type === 'approve') {
      log.info({ code: parsed.code }, 'Approve via OpenClaw');
      this.approvalApi.approveByCode(parsed.code);
    } else {
      log.info({ code: parsed.code }, 'Deny via OpenClaw');
      this.approvalApi.denyByCode(parsed.code, parsed.reason);
    }
  }

  notify(requests: HitlNotification[]): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      log.error('OpenClaw WS not connected, cannot send HITL notification');
      return Promise.resolve();
    }

    const message = formatBatch(requests);
    const rpc = {
      jsonrpc: '2.0',
      id: generateId(),
      method: 'chat.send',
      params: {
        sessionKey: this.config.session_key,
        message,
        idempotencyKey: generateId(),
      },
    };

    this.ws.send(JSON.stringify(rpc));
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
    return Promise.resolve();
  }
}

function extractText(msg: Record<string, unknown>): string | null {
  // Try common message shapes
  const text = msg['text'] ?? msg['content'] ?? msg['message'] ?? msg['params'];
  if (typeof text === 'string') return text;
  if (typeof text === 'object' && text !== null) {
    return extractText(text as Record<string, unknown>);
  }
  return null;
}
