import { isDeepStrictEqual } from 'util';
import { Document, isMap, parseDocument, type YAMLMap } from 'yaml';

/**
 * Render `next` as YAML while keeping the comments, key order and formatting of `raw` wherever the
 * value did not change. Writers that edit the config as plain objects use this so an operator's
 * hand-written comments survive a dashboard save or an "always allow" approval.
 *
 * Maps are merged key by key; any other changed value (scalars, lists) is replaced whole.
 */
export function stringifyPreservingComments(raw: string, next: Record<string, unknown>): string {
  const doc = parseDocument(raw);
  if (doc.errors.length > 0 || !isMap(doc.contents)) {
    return new Document(next).toString();
  }
  mergeMap(doc, doc.contents, next);
  return doc.toString();
}

function mergeMap(doc: Document, node: YAMLMap, next: Record<string, unknown>): void {
  for (const pair of [...node.items]) {
    const key = keyOf(pair.key);
    if (key !== undefined && !(key in next)) node.delete(pair.key);
  }
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) {
      node.delete(key);
      continue;
    }
    const current = node.get(key, true);
    if (isMap(current) && isPlainObject(value)) {
      mergeMap(doc, current, value);
    } else if (!isDeepStrictEqual(toJs(current), value)) {
      node.set(key, doc.createNode(value));
    }
  }
}

function keyOf(key: unknown): string | undefined {
  if (typeof key === 'string') return key;
  if (key && typeof key === 'object' && 'value' in key)
    return String((key as { value: unknown }).value);
  return undefined;
}

function toJs(node: unknown): unknown {
  if (node && typeof node === 'object' && 'toJSON' in node) {
    return (node as { toJSON(): unknown }).toJSON();
  }
  return node;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
