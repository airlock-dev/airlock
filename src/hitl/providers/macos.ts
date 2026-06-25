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
    await Promise.all(requests.map((req) => this.showDialog(req)));
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
    scriptLines.push(
      `set msg to "${escaped}"`,
      `display dialog msg with title "${title}" buttons {"Deny", "Approve"} default button "Approve" with icon caution giving up after ${timeoutSec}`
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

        if (output.includes('Approve')) {
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
