import { execFile } from 'child_process';
import { childLogger } from '../../util/logger.js';
import type { HitlProvider, HitlNotification, ApprovalApi } from './types.js';

const log = childLogger('hitl-macos');

export interface MacosHitlProviderOptions {
  sound?: string; // macOS sound name, e.g. "Submarine", "Glass", "Ping"
}

export class MacosHitlProvider implements HitlProvider {
  private sound: string | undefined;

  constructor(
    private approvalApi: ApprovalApi,
    options?: MacosHitlProviderOptions
  ) {
    this.sound = options?.sound;
  }

  init(): Promise<void> {
    log.info('macOS dialog HITL provider ready');
    return Promise.resolve();
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }

  async notify(requests: HitlNotification[]): Promise<void> {
    const batchCode = requests[0]?.batchCode;
    if (requests.length > 1 && batchCode) {
      const choice = await this.showBatchDialog(requests, batchCode);
      if (choice === 'denied' || choice === 'gave-up') return;
      if (choice === 'approved') {
        // Approve all skipped flagged calls, plans and questions: each still needs its own dialog.
        const skipped = requests.filter((req) => req.escalated || (req.kind ?? 'call') !== 'call');
        await Promise.all(skipped.map((req) => this.showDialog(req)));
        return;
      }
    }
    await Promise.all(requests.map((req) => this.showDialog(req)));
  }

  /** One dialog for a burst: approve all, deny all, or fall through to one dialog each. */
  private showBatchDialog(
    requests: HitlNotification[],
    batchCode: string
  ): Promise<'approved' | 'denied' | 'review' | 'gave-up'> {
    const flagged = requests.filter((req) => req.escalated).length;
    const lines = [
      `Agent: ${requests[0].agentId}`,
      '',
      ...requests
        .slice(0, 15)
        .map(
          (req) => `• ${req.tool.replace(/^[^/]+\//, '')}${req.escalated ? '  ⚠️ flagged' : ''}`
        ),
      ...(requests.length > 15 ? [`+${requests.length - 15} more`] : []),
      ...(flagged > 0 ? ['', `Approve all skips the ${flagged} flagged call(s).`] : []),
      ...(requests.some((req) => (req.kind ?? 'call') !== 'call')
        ? ['', 'Plans and questions are shown separately after Approve all.']
        : []),
    ];
    const escaped = escapeAppleScript(lines.join('\n'));
    const title = escapeAppleScript(`Airlock — ${requests.length} approvals`);
    const timeoutSec = Math.ceil((requests[0].timeoutMs || 300_000) / 1000);
    const scriptLines: string[] = [];
    if (this.sound) {
      scriptLines.push(`do shell script "afplay /System/Library/Sounds/${this.sound}.aiff &"`);
    }
    scriptLines.push(
      `set msg to "${escaped}"`,
      `display dialog msg with title "${title}" buttons {"Deny all", "Review each", "Approve all"} default button "Approve all" with icon caution giving up after ${timeoutSec}`
    );

    return new Promise((resolve) => {
      execFile('osascript', ['-e', scriptLines.join('\n')], (err, stdout) => {
        const output = stdout?.trim() ?? '';
        if (output.includes('gave up:true')) {
          resolve('gave-up');
          return;
        }
        if (err) {
          // Dialog failed or was dismissed: fall back to one dialog per request.
          resolve('review');
          return;
        }
        if (output.includes('Approve all')) {
          log.info({ batchCode }, 'Batch approved via macOS dialog');
          this.approvalApi.approveByCode(batchCode);
          resolve('approved');
        } else if (output.includes('Deny all')) {
          log.info({ batchCode }, 'Batch denied via macOS dialog');
          this.approvalApi.denyByCode(batchCode, 'Denied via dialog');
          resolve('denied');
        } else {
          resolve('review');
        }
      });
    });
  }

  private showDialog(req: HitlNotification): Promise<void> {
    const argLines = Object.entries(req.args).map(([k, v]) => {
      let val: string;
      if (typeof v === 'string') {
        try {
          val = JSON.stringify(JSON.parse(v), null, 2);
        } catch {
          val = v;
        }
      } else {
        val = JSON.stringify(v, null, 2);
      }
      if (val.length > 300) val = val.slice(0, 300) + '\n  …';
      return `${k}:\n${val
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n')}`;
    });

    const timeoutSec = Math.ceil(req.timeoutMs / 1000);
    const tool = req.tool.replace(/^[^/]+\//, '');
    const contextLines = [
      req.context?.reason ? `Request reason: ${req.context.reason}` : undefined,
      req.context?.note ? `Request note:   ${req.context.note}` : undefined,
    ].filter((line): line is string => Boolean(line));
    const lines = [`Tool:  ${tool}`, `Agent: ${req.agentId}`, ...contextLines, '', ...argLines];
    const escaped = escapeAppleScript(lines.join('\n'));
    const title = escapeAppleScript(`Airlock — ${tool}`);

    // Build AppleScript: play a sound, then show the dialog.
    // Newlines must be injected via `return` (char 10) since display dialog
    // doesn't interpret escape sequences in string literals.
    const scriptLines: string[] = [];
    if (this.sound) {
      scriptLines.push(`do shell script "afplay /System/Library/Sounds/${this.sound}.aiff &"`);
    }
    // A third button widens the approval into a 15-minute grant for this tool.
    const canGrant = req.grantOptions?.some((option) => option.scope === 'tool') ?? false;
    const buttons = canGrant ? '{"Deny", "Allow 15m", "Approve"}' : '{"Deny", "Approve"}';
    scriptLines.push(
      `set msg to "${escaped}"`,
      `display dialog msg with title "${title}" buttons ${buttons} default button "Approve" with icon caution giving up after ${timeoutSec}`
    );
    const script = scriptLines.join('\n');

    return new Promise<void>((resolve) => {
      execFile('osascript', ['-e', script], (err, stdout) => {
        if (err) {
          log.info(
            { code: req.code, err: err.message },
            'macOS dialog dismissed, treating as deny'
          );
          this.approvalApi.denyByCode(req.code, 'Dialog dismissed');
          resolve();
          return;
        }

        const output = stdout.trim();
        if (output.includes('gave up:true')) {
          log.info({ code: req.code }, 'macOS dialog timed out');
          resolve();
          return;
        }

        if (output.includes('Allow 15m')) {
          log.info({ code: req.code }, 'Approved with a 15m tool grant via macOS dialog');
          try {
            this.approvalApi.approveByCode(req.code, {
              grant: { scope: 'tool', durationMs: 15 * 60_000 },
            });
          } catch (grantErr) {
            log.warn({ err: grantErr, code: req.code }, 'Grant rejected; approved once');
            this.approvalApi.approveByCode(req.code);
          }
        } else if (output.includes('Approve')) {
          log.info({ code: req.code }, 'Approved via macOS dialog');
          this.approvalApi.approveByCode(req.code);
        } else {
          log.info({ code: req.code }, 'Denied via macOS dialog');
          this.approvalApi.denyByCode(req.code, 'Denied via dialog');
        }
        resolve();
      });
    });
  }
}

/** Escape a string for use inside AppleScript double-quoted literals. */
function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
