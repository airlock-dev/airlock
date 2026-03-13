import type { Middleware } from '../types.js';
import { childLogger } from '../../util/logger.js';

const log = childLogger('mw:output-summarizer');

export interface OutputSummarizerOptions {
  /** Minimum character length before summarization kicks in */
  threshold_chars?: number;
  /** Model ID to use (provider-specific, e.g. 'claude-haiku-4-5-20251001', 'gpt-4o-mini') */
  model: string;
}

const DEFAULT_THRESHOLD = 10_000;

/**
 * Summarizes large tool outputs using the Vercel AI SDK.
 * Requires `ai` package and a provider to be configured.
 * The caller must pass a model string that the AI SDK can resolve.
 * Falls back gracefully if the SDK or model is unavailable.
 */
export function outputSummarizerMiddleware(opts: OutputSummarizerOptions): Middleware {
  const threshold = opts.threshold_chars ?? DEFAULT_THRESHOLD;

  return async (ctx, next) => {
    const response = await next();

    if (response.text.length < threshold) return response;

    try {
      // Dynamic import so this middleware doesn't hard-fail if `ai` isn't installed
      const { generateText } = await import('ai');

      const { text: summary } = await generateText({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
        model: opts.model as any, // provider-specific model reference
        system:
          'You are a concise technical summarizer. Summarize the following tool output, preserving key data, errors, and actionable information. Be brief.',
        prompt: response.text.slice(0, 50_000), // cap input
        maxOutputTokens: 1024,
      });

      response.text = `<summary>\n${summary}\n</summary>\n\n<original-length>${response.text.length} chars</original-length>`;
      if (response.fullOutputPath) {
        response.text += `\n<full-output>${response.fullOutputPath}</full-output>`;
      }
    } catch (err) {
      log.warn({ err }, 'Output summarization failed, returning raw output');
      // Fall through — return original response unchanged
    }

    return response;
  };
}
