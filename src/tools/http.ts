import { assertHostNotBlocked } from '../security/blocked-hosts.js';
import { isDomainAllowed } from '../security/domain-allowlist.js';
import type { AgentConfig, SecurityConfig } from '../config/schema.js';
import type { Tool } from '@modelcontextprotocol/server';
import { looksLikeUploadRef, parseUploadRef } from '../uploads/refs.js';
import { assertUploadPlanActive, type UploadExecutionPlan } from '../uploads/resolve.js';
import type { UploadStore } from '../uploads/store.js';

const MAX_RESPONSE_BYTES = 1_048_576; // 1MB default
const METHODS_WITH_BODY = new Set<HttpMethod>(['post', 'put', 'patch']);

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated?: boolean;
}

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export function buildHttpTools(opts: { uploadsEnabled?: boolean } = {}): Tool[] {
  return HTTP_METHODS.map((method) => {
    const supportsUploadBody = Boolean(opts.uploadsEnabled && METHODS_WITH_BODY.has(method));
    const properties: Record<string, object> = {
      url: { type: 'string', description: 'Full URL' },
      headers: {
        type: 'object',
        description: 'Request headers',
        additionalProperties: { type: 'string' },
      },
      body: { type: 'string', description: 'Request body (for POST/PUT/PATCH)' },
      timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default 30000)' },
    };
    if (supportsUploadBody) {
      properties.body_upload = {
        type: 'string',
        description:
          'Airlock upload ref ("airlock-upload://<id>") from airlock_prepare_upload to send as the raw binary request body (mutually exclusive with body and multipart).',
      };
      properties.multipart = {
        type: 'object',
        description:
          'Multipart form-data fields (mutually exclusive with body and body_upload). Values may be strings, numbers, booleans, "airlock-upload://<id>" file refs from airlock_prepare_upload, or arrays of them.',
        additionalProperties: {
          oneOf: [
            { type: 'string' },
            { type: 'number' },
            { type: 'boolean' },
            {
              type: 'array',
              items: {
                oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
              },
            },
          ],
        },
      };
    }
    return {
      name: `http/${method}`,
      description: `HTTP ${method.toUpperCase()} request`,
      inputSchema: {
        type: 'object' as const,
        properties: properties as NonNullable<Tool['inputSchema']['properties']>,
        required: ['url'],
      },
    };
  });
}

function hasHeaderCaseInsensitive(headers: Record<string, string>, name: string): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === target);
}

export async function executeHttp(
  method: HttpMethod,
  args: Record<string, unknown>,
  agentConfig: AgentConfig,
  securityConfig: SecurityConfig,
  uploadStore?: UploadStore,
  agentId?: string,
  sessionId?: string,
  uploadPlan?: UploadExecutionPlan
): Promise<HttpResult> {
  const url = args['url'] as string;
  const headers: Record<string, string> = {
    ...((args['headers'] ?? {}) as Record<string, string>),
  };
  const body = args['body'] as string | undefined;
  const bodyUpload = args['body_upload'];
  const multipart = args['multipart'];
  // The agent may ask for a shorter deadline, never a longer one than the operator configured.
  const requestedTimeout = args['timeout_ms'];
  const timeoutMs =
    typeof requestedTimeout === 'number' &&
    Number.isFinite(requestedTimeout) &&
    requestedTimeout > 0
      ? Math.min(requestedTimeout, agentConfig.http.timeout_ms)
      : agentConfig.http.timeout_ms;
  const maxBytes = agentConfig.http.max_response_bytes ?? MAX_RESPONSE_BYTES;

  const canSendBody = METHODS_WITH_BODY.has(method);
  if (!canSendBody && (bodyUpload !== undefined || multipart !== undefined)) {
    throw new Error(`HTTP ${method.toUpperCase()} does not support body_upload or multipart.`);
  }
  const bodyModesProvided = [
    body !== undefined,
    bodyUpload !== undefined,
    multipart !== undefined,
  ].filter(Boolean).length;
  if (bodyModesProvided > 1) {
    throw new Error('Specify at most one of "body", "body_upload", or "multipart".');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  const hostname = await assertHostNotBlocked(
    parsedUrl.hostname,
    securityConfig.blocked_hosts,
    securityConfig.allowed_local
  );

  if (!isDomainAllowed(hostname, agentConfig.http.domain_allowlist)) {
    throw new Error(`Domain not in agent allowlist: ${hostname}`);
  }

  let requestBody: string | ReadableStream<Uint8Array> | undefined = canSendBody ? body : undefined;
  let closeBodyStream: (() => void) | undefined;
  let needsDuplex = false;
  const nativeUploadIds: string[] = [];
  if (canSendBody && bodyUpload !== undefined) {
    if (!uploadStore?.isEnabled() || !agentId) {
      throw new Error('body_upload requires staged file uploads (set uploads.enabled: true).');
    }
    const parsedRef = parseUploadRef(bodyUpload);
    if (!parsedRef || parsedRef.mode) {
      throw new Error(
        'body_upload expects a bare Airlock upload ref ("airlock-upload://<id>") from airlock_prepare_upload.'
      );
    }
    const { record, stream, close } = await uploadStore.openVerifiedStream(
      agentId,
      parsedRef.id,
      sessionId
    );
    nativeUploadIds.push(parsedRef.id);
    if (!hasHeaderCaseInsensitive(headers, 'content-type')) {
      headers['Content-Type'] = record.contentType;
    }
    if (!hasHeaderCaseInsensitive(headers, 'content-length')) {
      headers['Content-Length'] = String(record.sizeBytes);
    }
    requestBody = stream;
    closeBodyStream = close;
    needsDuplex = true;
  } else if (canSendBody && multipart !== undefined) {
    if (!uploadStore?.isEnabled() || !agentId) {
      throw new Error('multipart requires staged file uploads (set uploads.enabled: true).');
    }
    if (typeof multipart !== 'object' || multipart === null || Array.isArray(multipart)) {
      throw new Error('multipart must be an object mapping field names to values or upload refs.');
    }
    if (hasHeaderCaseInsensitive(headers, 'content-type')) {
      throw new Error(
        'Do not set a Content-Type header when using multipart; Airlock generates the multipart boundary automatically.'
      );
    }
    const parts: Array<
      | { kind: 'text'; name: string; value: string }
      | { kind: 'upload'; name: string; uploadId: string }
    > = [];
    for (const [fieldName, rawValue] of Object.entries(multipart as Record<string, unknown>)) {
      if (rawValue === undefined) continue;
      const items = Array.isArray(rawValue) ? rawValue : [rawValue];
      for (const item of items) {
        if (looksLikeUploadRef(item)) {
          const parsedRef = parseUploadRef(item);
          if (!parsedRef || parsedRef.mode) {
            throw new Error(
              `multipart.${fieldName} expects a bare Airlock upload ref ("airlock-upload://<id>").`
            );
          }
          parts.push({ kind: 'upload', name: fieldName, uploadId: parsedRef.id });
          nativeUploadIds.push(parsedRef.id);
        } else {
          parts.push({ kind: 'text', name: fieldName, value: String(item) });
        }
      }
    }
    const streamed = await uploadStore.openStreamingMultipart(agentId, parts, sessionId);
    headers['Content-Type'] = streamed.contentType;
    headers['Content-Length'] = String(streamed.contentLength);
    requestBody = streamed.stream;
    closeBodyStream = streamed.close;
    needsDuplex = true;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const fetchInit: RequestInit & { duplex?: 'half' } = {
      method: method.toUpperCase(),
      headers,
      body: requestBody,
      signal: controller.signal,
      redirect: 'manual',
    };
    if (needsDuplex && fetchInit.body) {
      fetchInit.duplex = 'half';
    }
    // Final synchronous ownership check right before fetch so revocation after stream setup
    // aborts before dispatching any outbound request.
    if (uploadStore && agentId) {
      if (uploadPlan) {
        assertUploadPlanActive(uploadPlan, agentId, uploadStore, sessionId);
      } else if (nativeUploadIds.length > 0) {
        if (!uploadStore.isEnabled()) {
          throw new Error('File uploads were disabled before dispatch.');
        }
        for (const uploadId of nativeUploadIds) {
          if (!uploadStore.getReadyUpload(agentId, uploadId, sessionId)) {
            throw new Error(`Upload "${uploadId}" is no longer available.`);
          }
        }
      }
    }
    const response = await fetch(url, fetchInit);

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    // Stream response with size cap instead of buffering entirely
    let bodyText = '';
    let truncated = false;
    const reader = response.body?.getReader();

    if (reader) {
      let bytesRead = 0;
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = (await reader.read()) as { done: boolean; value: Uint8Array };
        if (done) break;
        bytesRead += value.byteLength;
        if (bytesRead <= maxBytes) {
          bodyText += decoder.decode(value, { stream: true });
        } else {
          // Only include up to the limit
          const overshoot = bytesRead - maxBytes;
          const usable = value.byteLength - overshoot;
          if (usable > 0) {
            bodyText += decoder.decode(value.slice(0, usable), { stream: true });
          }
          truncated = true;
          void reader.cancel();
          break;
        }
      }
      bodyText += decoder.decode(); // flush
    }

    return { status: response.status, headers: responseHeaders, body: bodyText, truncated };
  } catch (err) {
    closeBodyStream?.();
    if ((err as Error).name === 'AbortError') {
      throw new Error(`HTTP request timed out after ${timeoutMs}ms`, { cause: err });
    }
    throw err;
  } finally {
    // Cleared only here so the deadline also covers reading the body, not just the headers.
    clearTimeout(timer);
  }
}
