import type { ToolCallResponse } from './types.js';

interface TextBlock {
  type: 'text';
  text: string;
}

interface CallToolResultLike {
  content: unknown[];
  structuredContent?: unknown;
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

/** The text of a block the agent reads as text: a text block, or an embedded text resource. */
function blockText(block: unknown): string | undefined {
  if (isTextBlock(block)) return block.text;
  if (typeof block !== 'object' || block === null) return undefined;
  if ((block as { type?: unknown }).type !== 'resource') return undefined;
  const resource = (block as { resource?: unknown }).resource;
  if (typeof resource !== 'object' || resource === null) return undefined;
  const text = (resource as { text?: unknown }).text;
  return typeof text === 'string' ? text : undefined;
}

/**
 * Tools that return structuredContent usually repeat it as serialized JSON in a text block (the MCP
 * spec recommends it). Count it once: only structured content no text block mirrors is added.
 */
function unmirroredStructuredText(result: CallToolResultLike, texts: string[]): string | undefined {
  if (result.structuredContent === undefined) return undefined;
  const serialized = JSON.stringify(result.structuredContent);
  if (serialized === undefined) return undefined;
  const mirrored = texts.some((text) => {
    try {
      return JSON.stringify(JSON.parse(text)) === serialized;
    } catch {
      return false;
    }
  });
  return mirrored ? undefined : serialized;
}

/**
 * The text an agent reads from a tool result, which is what response middlewares scan and rewrite.
 * For a CallToolResult that is every textual part of it: text blocks, embedded text resources and
 * structuredContent. Anything else is shown to the agent as JSON.
 */
export function resultText(result: unknown): string {
  if (!isCallToolResult(result)) return JSON.stringify(result) ?? '';
  const texts = result.content.map(blockText).filter((text): text is string => text !== undefined);
  const structured = unmirroredStructuredText(result, texts);
  return [...texts, ...(structured !== undefined ? [structured] : [])].join('\n');
}

/**
 * The result to hand back to the client. Response middlewares (envelope, truncation, mangling,
 * canaries, summaries) rewrite `response.text`; for a CallToolResult that rewrite has to replace
 * every textual part, or the client would receive the untouched downstream content through the
 * parts left over. So the rewritten text takes the place of the first textual block, the other
 * textual blocks are dropped, non-text blocks (images, audio, links) keep their positions, and
 * structuredContent is dropped (its text is part of the rewrite). When no middleware changed the
 * text, or the result had no text to rewrite, the downstream result is returned as-is.
 */
export function deliveredResult(response: ToolCallResponse): unknown {
  const result = response.result;
  if (!isCallToolResult(result)) return result;
  const original = resultText(result);
  if (original === '' || response.text === original) return result;

  const rewritten: TextBlock = { type: 'text', text: response.text };
  let placed = false;
  const content: unknown[] = [];
  for (const block of result.content) {
    if (blockText(block) === undefined) {
      content.push(block);
    } else if (!placed) {
      content.push(rewritten);
      placed = true;
    }
  }
  if (!placed) content.unshift(rewritten);

  const { structuredContent: _structured, ...rest } = result;
  return { ...rest, content };
}
