/**
 * Custom pino destination for beautiful human-facing log output.
 * Runs in-process (not a worker thread) for compatibility with tsx/esm.
 * Writes to stderr to keep stdout clean for MCP stdio transport.
 */
import { Writable } from 'stream';
import pino from 'pino';

// ANSI color helpers
const reset = '\x1b[0m';
const dim = '\x1b[2m';
const bold = '\x1b[1m';
const italic = '\x1b[3m';

const fg = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

// Level config: icon, label, color
const levels: Record<number, { icon: string; color: string }> = {
  10: { icon: '·', color: fg.gray },
  20: { icon: '⚙', color: fg.gray },
  30: { icon: '●', color: fg.cyan },
  40: { icon: '▲', color: fg.yellow },
  50: { icon: '✖', color: fg.red },
  60: { icon: '💀', color: fg.red },
};

// Component colors — rotate through for visual grouping
const componentColors = [fg.cyan, fg.magenta, fg.blue, fg.green, fg.yellow];
const componentColorMap = new Map<string, string>();
let colorIndex = 0;

function getComponentColor(component: string): string {
  let color = componentColorMap.get(component);
  if (!color) {
    color = componentColors[colorIndex % componentColors.length];
    componentColorMap.set(component, color);
    colorIndex++;
  }
  return color;
}

function formatTime(epoch: number): string {
  const d = new Date(epoch);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  const s = d.getSeconds().toString().padStart(2, '0');
  return `${dim}${h}:${m}:${s}${reset}`;
}

function formatError(err: {
  type?: string;
  message?: string;
  stack?: string;
  code?: number;
}): string {
  const lines: string[] = [];
  const errType = err.type ?? 'Error';
  const msg = err.message ?? 'Unknown error';
  lines.push(`  ${fg.red}${bold}${errType}${reset}${fg.red}: ${msg}${reset}`);
  if (err.code !== undefined) {
    lines.push(`  ${dim}code: ${err.code}${reset}`);
  }
  if (err.stack) {
    const stackLines = err.stack.split('\n').slice(1, 4);
    for (const line of stackLines) {
      lines.push(`  ${dim}${line.trim()}${reset}`);
    }
  }
  return lines.join('\n');
}

function formatLogEntry(obj: Record<string, unknown>): string {
  const level = (obj.level as number) ?? 30;
  const time = (obj.time as number) ?? Date.now();
  const msg = (obj.msg as string) ?? '';
  const component = obj.component as string | undefined;
  const err = obj.err as
    | { type?: string; message?: string; stack?: string; code?: number }
    | undefined;

  const levelInfo = levels[level] ?? levels[30];

  // Collect extra fields (skip standard pino fields)
  const skipKeys = new Set([
    'level',
    'time',
    'pid',
    'hostname',
    'name',
    'msg',
    'component',
    'err',
    'v',
  ]);
  const extras: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (skipKeys.has(k)) continue;
    const val = typeof v === 'string' ? v : JSON.stringify(v);
    extras.push(`${dim}${k}=${reset}${italic}${val}${reset}`);
  }

  // Build line
  const parts: string[] = [];

  // Time
  parts.push(formatTime(time));

  // Level icon
  parts.push(`${levelInfo.color}${levelInfo.icon}${reset}`);

  // Component badge
  if (component) {
    const cc = getComponentColor(component);
    parts.push(`${cc}${bold}[${component}]${reset}`);
  }

  // Message
  if (msg) {
    const msgColor = level >= 50 ? fg.red : level >= 40 ? fg.yellow : fg.white;
    parts.push(`${msgColor}${msg}${reset}`);
  }

  // Extras inline
  if (extras.length > 0) {
    parts.push(extras.join(' '));
  }

  let line = parts.join(' ');

  // Error details on next lines
  if (err) {
    line += '\n' + formatError(err);
  }

  return line;
}

/** Create a pino destination stream that formats logs for humans */
export function createPrettyDestination(): pino.DestinationStream {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try {
        const str = chunk.toString().trim();
        if (!str) return callback();
        const obj = JSON.parse(str) as Record<string, unknown>;
        process.stderr.write(formatLogEntry(obj) + '\n');
        callback();
      } catch {
        // Not JSON — pass through to stderr
        process.stderr.write(chunk);
        callback();
      }
    },
  });
}
