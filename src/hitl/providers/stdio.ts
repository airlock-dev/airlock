import * as readline from 'readline';
import type { Readable } from 'stream';
import { formatBatch } from '../formatter.js';
import { applyApprovalCommand, parseApprovalCommand } from '../parser.js';
import type { HitlProvider, HitlNotification, ApprovalApi } from './types.js';
import { childLogger } from '../../util/logger.js';

const log = childLogger('hitl-stdio');

export class StdioHitlProvider implements HitlProvider {
  private rl?: readline.Interface;

  constructor(
    private approvalApi: ApprovalApi,
    private inputStream: Readable = process.stdin as unknown as Readable
  ) {}

  init(): Promise<void> {
    this.rl = readline.createInterface({ input: this.inputStream, terminal: false });
    this.rl.on('line', (line) => {
      const parsed = parseApprovalCommand(line);
      if (!parsed) return;

      log.info(
        { code: parsed.code, grant: parsed.grant },
        parsed.type === 'approve' ? 'Approve received via stdio' : 'Deny received via stdio'
      );
      applyApprovalCommand(this.approvalApi, parsed, (err) =>
        log.warn({ err, code: parsed.code }, 'Grant rejected; approved the single request only')
      );
    });
    log.info('Stdio HITL provider ready. Type: approve <CODE> or deny <CODE>');
    return Promise.resolve();
  }

  notify(requests: HitlNotification[]): Promise<void> {
    process.stderr.write('\n' + formatBatch(requests) + '\n\n');
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.rl?.close();
    return Promise.resolve();
  }
}
