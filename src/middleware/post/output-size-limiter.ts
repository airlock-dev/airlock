import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Middleware } from '../types.js';
import { childLogger } from '../../util/logger.js';

const log = childLogger('mw:output-size-limiter');

export interface OutputSizeLimiterOptions {
  max_lines?: number;
  max_chars?: number;
}

const DEFAULT_MAX_LINES = 200;
const DEFAULT_MAX_CHARS = 30_000;

export function outputSizeLimiterMiddleware(opts: OutputSizeLimiterOptions = {}): Middleware {
  const maxLines = opts.max_lines ?? DEFAULT_MAX_LINES;
  const maxChars = opts.max_chars ?? DEFAULT_MAX_CHARS;

  return async (ctx, next) => {
    const response = await next();
    const text = response.text;

    const lines = text.split('\n');
    const needsLineTruncation = lines.length > maxLines;
    const needsCharTruncation = text.length > maxChars;

    if (!needsLineTruncation && !needsCharTruncation) return response;

    // Write full output to file
    const dir = join(tmpdir(), 'airlock', ctx.agentId);
    const filePath = join(dir, `${ctx.callId}.txt`);

    try {
      await mkdir(dir, { recursive: true });
      await writeFile(filePath, text, 'utf-8');
      response.fullOutputPath = filePath;
    } catch (err) {
      log.warn({ err, filePath }, 'Failed to write full output to file');
    }

    // Truncate
    let truncated: string;
    if (needsLineTruncation) {
      truncated = lines.slice(0, maxLines).join('\n');
    } else {
      truncated = text.slice(0, maxChars);
    }

    const totalLines = lines.length;
    const totalChars = text.length;
    truncated += `\n\n[Truncated: ${totalLines} lines / ${totalChars} chars total. Full output: ${filePath}. Use exec/run with cat/grep to read.]`;

    response.text = truncated;
    response.truncated = true;
    return response;
  };
}
