import * as readline from 'readline';
import { formatBatch } from '../formatter.js';
import type { HitlProvider, HitlNotification, ApprovalApi } from './types.js';
import { childLogger } from '../../util/logger.js';

const log = childLogger('hitl-stdio');

export class StdioHitlProvider implements HitlProvider {
  private rl?: readline.Interface;

  constructor(private approvalApi: ApprovalApi) {}

  async init(): Promise<void> {
    this.rl = readline.createInterface({ input: process.stdin, terminal: false });
    this.rl.on('line', (line) => {
      const trimmed = line.trim();
      const approveMatch = trimmed.match(/^approve\s+([A-Z0-9]{6})$/i);
      const denyMatch    = trimmed.match(/^deny\s+([A-Z0-9]{6})(?:\s+(.+))?$/i);

      if (approveMatch) {
        // We don't have id from code here — engine handles code→id lookup
        log.info({ code: approveMatch[1] }, 'Approve received via stdio');
        this.approvalApi.approve(approveMatch[1]);
      } else if (denyMatch) {
        log.info({ code: denyMatch[1] }, 'Deny received via stdio');
        this.approvalApi.deny(denyMatch[1], denyMatch[2]);
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
