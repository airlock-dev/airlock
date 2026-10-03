import { randomUUID } from 'crypto';
import type { ApprovalPreviewConfig } from '../config/schema.js';
import type { ToolRegistry } from '../registry/registry.js';
import type { AuditLogger } from '../audit/logger.js';
import type { HitlNotification } from './providers/types.js';

type PreviewRequest = Pick<HitlNotification, 'id' | 'agentId' | 'tool' | 'args'>;

export type ApprovalPreviewField = { label: string; value: string; primary: boolean };

export type ApprovalPreview =
  | { status: 'unavailable' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      tool: string;
      text: string;
      truncated: boolean;
      fields?: ApprovalPreviewField[];
      requestedFields?: ApprovalPreviewField[];
    };

/** Operator reads are separate from both agent execution and approval notifications. */
export class ApprovalPreviewReader {
  private cache = new WeakMap<PreviewRequest, Promise<ApprovalPreview>>();

  constructor(
    private deps: {
      getHooks(): Record<string, ApprovalPreviewConfig>;
      getRegistry(): ToolRegistry;
      isPending(id: string): boolean;
      getRequest(id: string): PreviewRequest | undefined;
      auditLogger: AuditLogger;
    }
  ) {}

  isPending(id: string): boolean {
    return this.deps.isPending(id);
  }

  async readPending(id: string): Promise<ApprovalPreview> {
    const request = this.deps.getRequest(id);
    return request ? this.read(request) : { status: 'error', message: 'Approval has resolved.' };
  }

  async read(request: PreviewRequest): Promise<ApprovalPreview> {
    if (!this.isPending(request.id)) return { status: 'error', message: 'Approval has resolved.' };
    const hook = this.deps.getHooks()[request.tool];
    if (!hook) return { status: 'unavailable' };
    let preview = this.cache.get(request);
    if (!preview) {
      preview = this.fetch(request, hook);
      this.cache.set(request, preview);
    }
    const result = await preview;
    return this.isPending(request.id)
      ? result
      : { status: 'error', message: 'Approval has resolved.' };
  }

  private async fetch(
    request: PreviewRequest,
    hook: ApprovalPreviewConfig
  ): Promise<ApprovalPreview> {
    const startedAt = Date.now();
    let outcome = 'approval_preview_error';
    let timer: NodeJS.Timeout | undefined;
    const args: Record<string, unknown> = { ...hook.args };
    try {
      for (const [target, source] of Object.entries(hook.args_from)) {
        if (!Object.hasOwn(request.args, source) || request.args[source] === '[REDACTED]') {
          return { status: 'error', message: `Preview argument unavailable: ${source}` };
        }
        // Define an own data property, including for keys such as __proto__.
        Object.defineProperty(args, target, {
          value: request.args[source],
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      const registry = this.deps.getRegistry();
      const tool = registry.getAllTools().find((entry) => entry.name === hook.tool);
      if (!tool || tool.annotations?.readOnlyHint === false) {
        return { status: 'error', message: 'Preview tool unavailable or declared non-read-only.' };
      }
      if (registry.resolveToolName(hook.tool, request.agentId) !== hook.tool) {
        return {
          status: 'error',
          message: 'Preview tools must use an upstream name, without aliases.',
        };
      }
      const result = await Promise.race([
        registry.call(hook.tool, args, request.agentId, { downstreamSessionId: randomUUID() }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), hook.timeout_ms);
          timer.unref();
        }),
      ]);
      if (isRecord(result) && result.isError) {
        return { status: 'error', message: 'Preview read failed.' };
      }
      const redacted = this.deps.auditLogger.redactArgs({ value: result }).value;
      const text = previewText(redacted);
      const formatted = previewFields(redacted, text, hook);
      const requested = hook.request_fields?.length
        ? previewFields(this.deps.auditLogger.redactArgs(request.args), '', {
            ...hook,
            fields: hook.request_fields,
          })
        : undefined;
      outcome = 'approval_preview_success';
      return {
        status: 'ready',
        tool: hook.tool,
        text: formatted.fields.length
          ? formatted.fields.map((field) => `${field.label}: ${field.value}`).join('\n\n')
          : text.slice(0, hook.max_chars),
        truncated:
          (formatted.fields.length ? formatted.truncated : text.length > hook.max_chars) ||
          requested?.truncated === true,
        ...(formatted.fields.length ? { fields: formatted.fields } : {}),
        ...(requested?.fields.length ? { requestedFields: requested.fields } : {}),
      };
    } catch {
      // Upstream errors may contain message content or credentials. Never echo or log them.
      return { status: 'error', message: 'Preview read failed or exceeded its time limit.' };
    } finally {
      if (timer) clearTimeout(timer);
      this.deps.auditLogger.log({
        agent_id: request.agentId,
        request_id: request.id,
        tool: hook.tool,
        args: JSON.stringify(args),
        result: outcome,
        duration_ms: Date.now() - startedAt,
      });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function previewFields(result: unknown, text: string, hook: ApprovalPreviewConfig) {
  let value: unknown =
    isRecord(result) && result.structuredContent !== undefined
      ? result.structuredContent
      : isRecord(result) && Array.isArray(result.content)
        ? text
        : result;
  // FastMCP wraps results; many providers return JSON inside a text block.
  for (let depth = 0; depth < 4; depth++) {
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        break;
      }
    } else if (
      isRecord(value) &&
      Object.keys(value).length === 1 &&
      Object.hasOwn(value, 'result')
    ) {
      value = value.result;
    } else {
      break;
    }
  }
  const candidates = hook.fields
    ? hook.fields.map((field) => ({
        label: field.label,
        primary: field.primary,
        value:
          field.path !== undefined
            ? selectPath(value, field.path)
            : selectText(
                typeof value === 'string' ? value : text,
                field.text_prefix!,
                field.primary
              ),
      }))
    : isRecord(value) && Array.isArray(value.fields)
      ? value.fields.slice(0, 20)
      : [];
  const fields: ApprovalPreviewField[] = [];
  // An unmatched body selector must not replace readable content with headers alone.
  if (
    hook.fields?.some((field) => field.primary) &&
    !candidates.some(
      (field) =>
        isRecord(field) &&
        field.primary === true &&
        field.value !== undefined &&
        field.value !== null &&
        field.value !== '' &&
        !(Array.isArray(field.value) && field.value.length === 0)
    )
  ) {
    return { fields, truncated: false };
  }
  let remaining = hook.max_chars;
  let truncated =
    !hook.fields && isRecord(value) && Array.isArray(value.fields) && value.fields.length > 20;
  for (const field of candidates) {
    if (
      !isRecord(field) ||
      typeof field.label !== 'string' ||
      !field.label.trim() ||
      field.value === undefined ||
      field.value === null ||
      field.value === '' ||
      (Array.isArray(field.value) && field.value.length === 0)
    )
      continue;
    const label = field.label.slice(0, 100);
    const displayed =
      typeof field.value === 'string'
        ? field.value
        : Array.isArray(field.value) && field.value.every((item) => typeof item !== 'object')
          ? field.value.join(', ')
          : JSON.stringify(field.value, null, 2);
    if (!displayed) continue;
    if (remaining <= label.length + 4) {
      truncated = true;
      break;
    }
    const budget = remaining - label.length - 4;
    fields.push({ label, value: displayed.slice(0, budget), primary: field.primary === true });
    remaining -= label.length + 4 + fields[fields.length - 1].value.length;
    truncated ||= displayed.length > budget || field.label.length > 100;
  }
  return { fields, truncated };
}

function selectPath(value: unknown, path: string): unknown {
  if (!path) return value;
  let values: unknown[] = [value];
  let multiple = false;
  for (const part of path
    .slice(1)
    .split('/')
    .map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    values = values.flatMap((item) => {
      if (part === '*' && Array.isArray(item)) {
        multiple = true;
        return item as unknown[];
      }
      return item !== null && typeof item === 'object' && Object.hasOwn(item, part)
        ? [(item as Record<string, unknown>)[part]]
        : [];
    });
  }
  return multiple ? values.filter((item) => item !== undefined && item !== null) : values[0];
}

function selectText(text: string, prefix: string, primary: boolean): string | undefined {
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => line.trimStart().startsWith(prefix));
  if (index < 0) return undefined;
  const first = lines[index].trimStart().slice(prefix.length).trimStart();
  return primary ? [first, ...lines.slice(index + 1)].join('\n').trim() : first.trim();
}

function previewText(value: unknown): string {
  if (isRecord(value)) {
    if (value.structuredContent !== undefined)
      return JSON.stringify(value.structuredContent, null, 2);
    if (Array.isArray(value.content)) {
      return (
        value.content
          .filter(
            (block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string'
          )
          .map((block) => (block as { text: string }).text)
          .join('\n\n') || 'No text preview returned.'
      );
    }
  }
  return typeof value === 'string'
    ? value
    : (JSON.stringify(value, null, 2) ?? 'No preview returned.');
}
