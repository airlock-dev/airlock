import type { UploadDeliveryMode } from '../config/schema.js';

export const UPLOAD_REF_PREFIX = 'airlock-upload://';

export const UPLOAD_ID_PATTERN = /^upl_[A-Za-z0-9_-]{22}$/;

const UPLOAD_REF_PATTERN =
  /^airlock-upload:\/\/(upl_[A-Za-z0-9_-]{22})(?::(base64|data_uri|text|path|url))?$/;

const MIME_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

const EXTENSION_MIME_TYPES: Record<string, string> = {
  '.3mf': 'model/3mf',
  '.stl': 'model/stl',
  '.obj': 'model/obj',
  '.step': 'model/step',
  '.stp': 'model/step',
  '.gcode': 'text/x-gcode',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tgz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.toml': 'application/toml',
  '.xml': 'application/xml',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.ts': 'text/typescript',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.wasm': 'application/wasm',
};

export interface ParsedUploadRef {
  raw: string;
  id: string;
  mode?: UploadDeliveryMode;
}

export interface FoundUploadRef {
  /** RFC 6901 JSON Pointer within tool arguments (collision-free even for keys with `.` or `[`). */
  pointer: string;
  /** Exact object-key / array-index path segments from root `args`. */
  segments: ReadonlyArray<string | number>;
  /** Human-readable path for diagnostics (e.g. `files[0].data`). */
  path: string;
  /** Top-level argument key under `args`. */
  topKey: string;
  /** Raw string value encountered. */
  value: string;
  /** Parsed structure when well-formed; undefined for malformed `airlock-upload://...` strings. */
  parsed?: ParsedUploadRef;
}

export function encodeJsonPointer(segments: ReadonlyArray<string | number>): string {
  return (
    '/' + segments.map((seg) => String(seg).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')
  );
}

export function looksLikeUploadRef(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(UPLOAD_REF_PREFIX);
}

export function parseUploadRef(value: unknown): ParsedUploadRef | undefined {
  if (typeof value !== 'string') return undefined;
  const match = UPLOAD_REF_PATTERN.exec(value);
  if (!match) return undefined;
  return {
    raw: value,
    id: match[1],
    ...(match[2] ? { mode: match[2] as UploadDeliveryMode } : {}),
  };
}

export function formatUploadRef(id: string, mode?: UploadDeliveryMode): string {
  return mode ? `${UPLOAD_REF_PREFIX}${id}:${mode}` : `${UPLOAD_REF_PREFIX}${id}`;
}

export function findUploadRefs(args: Record<string, unknown>): FoundUploadRef[] {
  const found: FoundUploadRef[] = [];

  function walk(
    value: unknown,
    segments: Array<string | number>,
    path: string,
    topKey: string
  ): void {
    if (typeof value === 'string') {
      if (looksLikeUploadRef(value)) {
        found.push({
          pointer: encodeJsonPointer(segments),
          segments: [...segments],
          path,
          topKey,
          value,
          parsed: parseUploadRef(value),
        });
      }
      return;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        walk(value[i], [...segments, i], `${path}[${i}]`, topKey);
      }
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        walk(nested, [...segments, key], path ? `${path}.${key}` : key, topKey || key);
      }
    }
  }

  for (const [key, value] of Object.entries(args)) {
    walk(value, [key], key, key);
  }

  return found;
}

function setOwnDataProperty(obj: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(obj, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export function annotateUploadArgs(
  args: Record<string, unknown>,
  describe: (ref: ParsedUploadRef) => string | undefined
): Record<string, unknown> {
  function transform(value: unknown): unknown {
    if (typeof value === 'string') {
      const parsed = parseUploadRef(value);
      if (!parsed) return value;
      const summary = describe(parsed);
      return summary ? `${value} (${summary})` : value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => transform(item));
    }
    if (value && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        setOwnDataProperty(result, key, transform(nested));
      }
      return result;
    }
    return value;
  }

  return transform(args) as Record<string, unknown>;
}

export async function replaceUploadRefs(
  args: Record<string, unknown>,
  resolve: (info: {
    pointer: string;
    segments: ReadonlyArray<string | number>;
    path: string;
    topKey: string;
    ref: ParsedUploadRef;
  }) => Promise<string>
): Promise<Record<string, unknown>> {
  async function transform(
    value: unknown,
    segments: Array<string | number>,
    path: string,
    topKey: string
  ): Promise<unknown> {
    if (typeof value === 'string') {
      const parsed = parseUploadRef(value);
      if (!parsed) return value;
      return resolve({
        pointer: encodeJsonPointer(segments),
        segments,
        path,
        topKey,
        ref: parsed,
      });
    }
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (let i = 0; i < value.length; i += 1) {
        out.push(await transform(value[i], [...segments, i], `${path}[${i}]`, topKey));
      }
      return out;
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        setOwnDataProperty(
          out,
          key,
          await transform(nested, [...segments, key], path ? `${path}.${key}` : key, topKey || key)
        );
      }
      return out;
    }
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    setOwnDataProperty(result, key, await transform(value, [key], key, key));
  }
  return result;
}

/** Replace any lone UTF-16 surrogates with U+FFFD so `encodeURIComponent` never throws `URIError`. */
export function toWellFormedUnicode(value: string): string {
  return value.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '\uFFFD'
  );
}

function truncateUtf8CodePoints(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let out = '';
  let bytes = 0;
  for (const ch of value) {
    const chBytes = Buffer.byteLength(ch, 'utf8');
    if (bytes + chBytes > maxBytes) break;
    out += ch;
    bytes += chBytes;
  }
  return out;
}

/**
 * Turn an untrusted filename into a single safe basename with no path separators, control
 * characters, quotes, leading dots, or malformed UTF-16 surrogates, bounded to <= 180 UTF-8 bytes
 * on Unicode code-point boundaries (always safely below POSIX 255-byte NAME_MAX).
 */
export function sanitizeFilename(raw?: string): string {
  if (!raw) return 'upload.bin';
  // Take only the final path component across POSIX and Windows separators.
  const segments = toWellFormedUnicode(raw).split(/[\\/]/).filter(Boolean);
  let base = segments[segments.length - 1] ?? '';
  // Strip control characters, quotes, semicolons, and path-like characters.
  // eslint-disable-next-line no-control-regex
  base = base.replace(/[\x00-\x1f\x7f"';<>|*?]/g, '').trim();
  // Prevent hidden files, "." or ".."
  base = base.replace(/^\.+/, '').trim();
  if (!base) return 'upload.bin';

  const MAX_UTF8_BYTES = 180;
  if (Buffer.byteLength(base, 'utf8') > MAX_UTF8_BYTES) {
    const dot = base.lastIndexOf('.');
    if (dot > 0) {
      const ext = base.slice(dot);
      const extBytes = Buffer.byteLength(ext, 'utf8');
      if (extBytes <= 24 && extBytes < MAX_UTF8_BYTES) {
        base = truncateUtf8CodePoints(base.slice(0, dot), MAX_UTF8_BYTES - extBytes) + ext;
      } else {
        base = truncateUtf8CodePoints(base, MAX_UTF8_BYTES);
      }
    } else {
      base = truncateUtf8CodePoints(base, MAX_UTF8_BYTES);
    }
  }
  return toWellFormedUnicode(base) || 'upload.bin';
}

export function normalizeMimeType(raw?: string): string | undefined {
  if (!raw) return undefined;
  const primary = raw.split(';')[0]?.trim().toLowerCase();
  if (!primary || !MIME_TYPE_PATTERN.test(primary)) return undefined;
  return primary;
}

export function inferMimeType(filename: string, provided?: string): string {
  const normalized = normalizeMimeType(provided);
  if (normalized && normalized !== 'application/octet-stream') {
    return normalized;
  }
  const lower = filename.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot >= 0) {
    const ext = lower.slice(dot);
    if (EXTENSION_MIME_TYPES[ext]) {
      return EXTENSION_MIME_TYPES[ext];
    }
  }
  return normalized ?? 'application/octet-stream';
}

export function matchesMimeAllowlist(mimeType: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  const normalized = mimeType.toLowerCase();
  const [type] = normalized.split('/');
  return allowlist.some((pattern) => {
    const p = pattern.trim().toLowerCase();
    if (!p) return false;
    if (p === '*' || p === '*/*') return true;
    if (p.endsWith('/*')) {
      return p.slice(0, -2) === type;
    }
    return p === normalized;
  });
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
