import { createReadStream } from 'fs';
import { childLogger } from '../../util/logger.js';
import type { HitlProvider, HitlNotification, ApprovalApi } from './types.js';

const log = childLogger('hitl-tui');

// ANSI helpers
const ESC = '\x1b[';
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const RESET = `${ESC}0m`;
const GREEN = `${ESC}32m`;
const RED = `${ESC}31m`;
const YELLOW = `${ESC}33m`;
const CYAN = `${ESC}36m`;
const BG_GRAY = `${ESC}48;5;236m`;

interface PendingItem {
  req: HitlNotification;
  status: 'pending' | 'approved' | 'denied';
}

export class TuiHitlProvider implements HitlProvider {
  private tty: typeof import('fs') extends { createReadStream: infer T } ? ReturnType<typeof createReadStream> : never;
  private items: PendingItem[] = [];
  private selected = 0;
  private active = false;

  constructor(private approvalApi: ApprovalApi) {
    // Read keystrokes from /dev/tty — doesn't touch stdin/stdout
    this.tty = createReadStream('/dev/tty', { encoding: 'utf8' }) as any;
  }

  async init(): Promise<void> {
    this.active = true;

    // Put tty in raw mode to get individual keypresses
    const fd = (this.tty as any).fd;
    if (typeof fd === 'number') {
      try {
        const tty = await import('tty');
        if (tty.isatty(fd)) {
          // We need the actual tty fd for raw mode
          const { openSync } = await import('fs');
          const ttyFd = openSync('/dev/tty', 'r');
          const ttyReadStream = new tty.ReadStream(ttyFd);
          ttyReadStream.setRawMode(true);
          ttyReadStream.setEncoding('utf8');
          ttyReadStream.on('data', (key: string) => this.handleKey(key));
          ttyReadStream.resume();
          this.tty = ttyReadStream as any;
        }
      } catch {
        // Fallback: line-based input
        this.tty.setEncoding('utf8');
        this.tty.on('data', (chunk: Buffer | string) => {
          for (const ch of String(chunk)) this.handleKey(ch);
        });
        this.tty.resume();
      }
    }

    log.info('TUI HITL provider ready — approve/deny from your terminal');
  }

  async stop(): Promise<void> {
    this.active = false;
    try {
      (this.tty as any).destroy?.();
    } catch {}
  }

  async notify(requests: HitlNotification[]): Promise<void> {
    for (const req of requests) {
      this.items.push({ req, status: 'pending' });
    }
    this.render();
  }

  private handleKey(key: string): void {
    if (!this.active) return;

    const pending = this.items.filter(i => i.status === 'pending');
    if (pending.length === 0) return;

    // Ctrl-C
    if (key === '\x03') {
      process.exit(0);
    }

    // j / down arrow
    if (key === 'j' || key === `${ESC}B`) {
      this.selected = Math.min(this.selected + 1, pending.length - 1);
      this.render();
      return;
    }

    // k / up arrow
    if (key === 'k' || key === `${ESC}A`) {
      this.selected = Math.max(this.selected - 1, 0);
      this.render();
      return;
    }

    // a = approve
    if (key === 'a' || key === 'A') {
      const item = pending[this.selected];
      if (item) {
        item.status = 'approved';
        this.approvalApi.approve(item.req.code);
        log.info({ code: item.req.code }, 'Approved via TUI');
        this.selected = Math.min(this.selected, Math.max(pending.length - 2, 0));
        this.render();
      }
      return;
    }

    // d = deny
    if (key === 'd' || key === 'D') {
      const item = pending[this.selected];
      if (item) {
        item.status = 'denied';
        this.approvalApi.deny(item.req.code, 'Denied via TUI');
        log.info({ code: item.req.code }, 'Denied via TUI');
        this.selected = Math.min(this.selected, Math.max(pending.length - 2, 0));
        this.render();
      }
      return;
    }
  }

  private render(): void {
    const out = process.stderr;
    const pending = this.items.filter(i => i.status === 'pending');
    const resolved = this.items.filter(i => i.status !== 'pending');

    const lines: string[] = [];
    lines.push('');
    lines.push(`${BOLD}${CYAN}  Airlock Approvals${RESET}  ${DIM}[a]pprove  [d]eny  [j/k] navigate${RESET}`);
    lines.push(`${DIM}  ${'─'.repeat(60)}${RESET}`);

    if (pending.length === 0) {
      lines.push(`${DIM}  No pending requests${RESET}`);
    } else {
      for (let i = 0; i < pending.length; i++) {
        const item = pending[i];
        const selected = i === this.selected;
        const prefix = selected ? `${BOLD}${YELLOW} ▸ ` : `${DIM}   `;
        const args = this.formatArgs(item.req.args);
        lines.push(
          `${prefix}${selected ? BOLD : ''}${item.req.tool}${RESET}` +
          `  ${DIM}agent:${item.req.agentId}${RESET}` +
          `  ${DIM}[${item.req.code}]${RESET}`
        );
        lines.push(`${selected ? '     ' : '     '}${DIM}${args}${RESET}`);
      }
    }

    // Show recently resolved
    const recent = resolved.slice(-3);
    if (recent.length > 0) {
      lines.push(`${DIM}  ${'─'.repeat(60)}${RESET}`);
      for (const item of recent) {
        const color = item.status === 'approved' ? GREEN : RED;
        lines.push(`${DIM}   ${color}${item.status}${RESET}${DIM}  ${item.req.tool}  [${item.req.code}]${RESET}`);
      }
    }

    lines.push('');

    // Clear previous output and write new
    out.write(`${ESC}2J${ESC}H`); // clear screen, cursor to top
    out.write(lines.join('\n'));
  }

  private formatArgs(args: Record<string, unknown>): string {
    const parts = Object.entries(args).map(([k, v]) => {
      const val = typeof v === 'string'
        ? (v.length > 40 ? `"${v.slice(0, 40)}..."` : `"${v}"`)
        : JSON.stringify(v);
      return `${k}: ${val}`;
    });
    const str = parts.join(', ');
    return str.length > 70 ? str.slice(0, 70) + '...' : str;
  }
}
