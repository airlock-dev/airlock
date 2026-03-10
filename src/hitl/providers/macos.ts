import { execFile } from 'child_process';
import { childLogger } from '../../util/logger.js';
import type { HitlProvider, HitlNotification, ApprovalApi } from './types.js';

const log = childLogger('hitl-macos');

export class MacosHitlProvider implements HitlProvider {
  constructor(private approvalApi: ApprovalApi) {}

  async init(): Promise<void> {
    log.info('macOS dialog HITL provider ready');
  }

  async stop(): Promise<void> {}

  async notify(requests: HitlNotification[]): Promise<void> {
    // Show each request as a separate dialog (in parallel)
    await Promise.all(requests.map(req => this.showDialog(req)));
  }

  private showDialog(req: HitlNotification): Promise<void> {
    const argSummary = Object.entries(req.args)
      .map(([k, v]) => {
        const val = typeof v === 'string'
          ? (v.length > 100 ? `${v.slice(0, 100)}...` : v)
          : JSON.stringify(v);
        return `  ${k}: ${val}`;
      })
      .join('\n');

    const timeoutSec = Math.ceil(req.timeoutMs / 1000);
    const message = `Agent: ${req.agentId}\\nTool: ${req.tool}\\n\\n${argSummary}\\n\\nCode: ${req.code}`;

    return new Promise<void>((resolve) => {
      execFile('osascript', [
        '-e',
        `display dialog "${message}" with title "Airlock Approval" buttons {"Deny", "Approve"} default button "Approve" with icon caution giving up after ${timeoutSec}`,
      ], (err, stdout) => {
        if (err) {
          // User closed the dialog or hit cancel — treat as deny
          log.info({ code: req.code }, 'macOS dialog dismissed, treating as deny');
          this.approvalApi.deny(req.code, 'Dialog dismissed');
          resolve();
          return;
        }

        const output = stdout.trim();
        if (output.includes('gave up:true')) {
          log.info({ code: req.code }, 'macOS dialog timed out');
          // Let the engine's own timeout handle it
          resolve();
          return;
        }

        if (output.includes('Approve')) {
          log.info({ code: req.code }, 'Approved via macOS dialog');
          this.approvalApi.approve(req.code);
        } else {
          log.info({ code: req.code }, 'Denied via macOS dialog');
          this.approvalApi.deny(req.code, 'Denied via dialog');
        }
        resolve();
      });
    });
  }
}
