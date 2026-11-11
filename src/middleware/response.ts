import type { ToolCallResponse } from './types.js';

interface TextBlock {
  type: 'text';
  text: string;
}

interface CallToolResultLike {
  content: unknown[];
}

/** Whether a downstream result already has the MCP CallToolResult shape (`content: [...]`). */
export function isCallToolResult(value: unknown): value is CallToolResultLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

function isTextBlock(block: unknown): block is TextBlock {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as { type?: unknown }).type === 'text' &&
    typeof (block as { text?: unknown }).text === 'string'
  );
}

/**
 * The text an agent reads from a tool result, which is what response middlewares scan and rewrite.
 * For a CallToolResult that is its text blocks; anything else is shown to the agent as JSON.
 */
export function resultText(result: unknown): string {
  if (isCallToolResult(result)) {
    return result.content
      .filter(isTextBlock)
      .map((block) => block.text)
      .join('\n');
  }
  return JSON.stringify(result) ?? '';
}

/**
 * The result to hand back to the client. Response middlewares (envelope, truncation, mangling,
 * canaries, summaries) rewrite `response.text`; for a CallToolResult that rewrite has to replace its
 * text blocks, or the client would receive the untouched downstream content. Non-text blocks and
 * every other field (structuredContent, isError, …) are kept. When no middleware changed the text,
 * the downstream result is returned as-is.
 */
export function deliveredResult(response: ToolCallResponse): unknown {
  const result = response.result;
  if (!isCallToolResult(result) || response.text === resultText(result)) return result;
  return {
    ...result,
    content: [
      { type: 'text', text: response.text },
      ...result.content.filter((block) => !isTextBlock(block)),
    ],
  };
}
