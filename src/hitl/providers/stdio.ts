import * as readline from 'readline';
import type { Readable } from 'stream';
import { formatBatch } from '../formatter.js';
import { parseApprovalCommand } from '../parser.js';
import type { HitlProvider, HitlNotification, ApprovalApi } from './types.js';
import { childLogger } from '../../util/logger.js';

const log = childLogger('hitl-stdio');

export class StdioHitlProvider implements HitlProvider {
  private rl?: readline.Interface;

  constructor(
    private approvalApi: ApprovalApi,
    private inputStream: Readable = process.stdin as unknown as Readable,
  ) {}

  async init(): Promise<void> {
    this.rl = readline.createInterface({ input: this.inputStream, terminal: false });
    this.rl.on('line', (line) => {
      const parsed = parseApprovalCommand(line);
      if (!parsed) return;

      if (parsed.type === 'approve') {
        log.info({ code: parsed.code }, 'Approve received via stdio');
        this.approvalApi.approve(parsed.code);
      } else {
        log.info({ code: parsed.code }, 'Deny received via stdio');
        this.approvalApi.deny(parsed.code, parsed.reason);
      }
    });
    log.info('Stdio HITL provider ready. Type: approve <CODE> or deny <CODE>');
  }

  async notify(requests: HitlNotification[]): Promise<void> {
    process.stderr.write('\n' + formatBatch(requests) + '\n\n');
  }

  async stop(): Promise<void> {
    this.rl?.close();
  }
}
