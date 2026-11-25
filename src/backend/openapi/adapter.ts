import { ProtocolError, type Tool } from '@modelcontextprotocol/server';
import type { ValidateFunction } from 'ajv';
import type { BackendAdapter } from '../types.js';
import type { ToolCall, ToolResult } from '../../types.js';
import type { ApiConfig, SecurityConfig } from '../../config/schema.js';
import { parseOpenApiSpec, type ParsedApi, type ParsedOperation } from './parser.js';
import { assertHostNotBlocked } from '../../security/blocked-hosts.js';
import { parseUploadRef } from '../../uploads/refs.js';
import {
  assertUploadPlanActive,
  materializeUploadArgs,
  type UploadExecutionPlan,
} from '../../uploads/resolve.js';
import type {
  MultipartFieldSpec,
  StreamingMultipartBody,
  UploadStore,
} from '../../uploads/store.js';

function stringifyParameterValue(paramName: string, value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value.toString();
  if (Array.isArray(value)) {
    return value.map((item) => stringifyParameterValue(paramName, item)).join(',');
  }
  throw new Error(`Parameter "${paramName}" must be a scalar or an array of scalars`);
}

function stringifyFormFieldValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value.toString();
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}

export class OpenApiAdapter implements BackendAdapter {
  readonly id: string;
  private parsedApi?: ParsedApi;
  private operationMap = new Map<string, ParsedOperation>();

  constructor(
    private configKey: string,
    private config: ApiConfig,
    private security: SecurityConfig,
    private uploadStore?: UploadStore
  ) {
    this.id = `api:${configKey}`;
  }

  nativeUploadArgKind(toolName: string, topKey: string): 'binary' | 'multipart' | undefined {
    const op = this.operationMap.get(toolName);
    if (!op) return undefined;
    if (
      op.bodyKind === 'multipart' &&
      (op.fileFields.includes(topKey) || op.arrayFileFields.includes(topKey))
    ) {
      return 'multipart';
    }
    if (op.bodyKind === 'binary' && op.binaryArgName === topKey) {
      return 'binary';
    }
    return undefined;
  }

  async listTools(): Promise<Tool[]> {
    if (!this.parsedApi) {
      this.parsedApi = await parseOpenApiSpec(this.config.spec, {
        include: this.config.include,
        exclude: this.config.exclude,
        baseUrlOverride: this.config.base_url,
      });
    }

    this.operationMap.clear();
    const tools: Tool[] = [];

    for (const op of this.parsedApi.operations) {
      const namespacedName = `${this.configKey}/${op.name}`;
      this.operationMap.set(namespacedName, op);
      tools.push({
        name: namespacedName,
        description: op.description ?? `${op.method.toUpperCase()} ${op.path}`,
        inputSchema: op.inputSchema,
      });
    }

    return tools;
  }

  async call(toolCall: ToolCall): Promise<ToolResult> {
    const op = this.operationMap.get(toolCall.tool);
    if (!op) {
      return { success: false, error: `Unknown operation: ${toolCall.tool}` };
    }

    // Materialize any configured/suffix upload refs once up front so path params, query params,
    // ordinary multipart fields, and JSON bodies all use the exact validated effective values.
    // Native multipart file fields and binary bodies are excluded from uploadPlan by uploadPolicy.
    const sessionId =
      typeof toolCall.meta?.downstreamSessionId === 'string'
        ? toolCall.meta.downstreamSessionId
        : undefined;
    let effectiveArgs = toolCall.args;
    const uploadPlan = toolCall.meta?.uploadPlan as UploadExecutionPlan | undefined;
    if (uploadPlan && this.uploadStore) {
      try {
        effectiveArgs = await materializeUploadArgs(
          toolCall.args,
          toolCall.agentId,
          uploadPlan,
          this.uploadStore,
          sessionId,
          { schemaValidator: toolCall.meta?.schemaValidator as ValidateFunction | undefined }
        );
      } catch (err) {
        if (err instanceof ProtocolError) throw err;
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    // Build URL
    let url = this.parsedApi!.baseUrl + op.path;

    try {
      // Replace path params
      for (const paramName of op.pathParams) {
        const value = effectiveArgs[paramName];
        if (value === undefined) {
          return { success: false, error: `Missing required path parameter: ${paramName}` };
        }
        url = url.replace(
          `{${paramName}}`,
          encodeURIComponent(stringifyParameterValue(paramName, value))
        );
      }

      // Add query params
      const queryParts: string[] = [];
      for (const paramName of op.queryParams) {
        const value = effectiveArgs[paramName];
        if (value !== undefined) {
          queryParts.push(
            `${encodeURIComponent(paramName)}=${encodeURIComponent(stringifyParameterValue(paramName, value))}`
          );
        }
      }
      if (queryParts.length > 0) {
        url += '?' + queryParts.join('&');
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Invalid parameter' };
    }

    // Security: check blocked hosts
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return { success: false, error: `Invalid URL: ${url}` };
    }

    try {
      await assertHostNotBlocked(
        parsedUrl.hostname,
        this.security.blocked_hosts,
        this.security.allowed_local
      );
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    // Build headers
    const headers: Record<string, string> = {};
    if (op.bodyKind !== 'multipart' && op.bodyKind !== 'binary') {
      headers['Content-Type'] = 'application/json';
    }
    if (this.config.auth) {
      if (this.config.auth.type === 'bearer') {
        headers['Authorization'] = `Bearer ${this.config.auth.token}`;
      } else if (this.config.auth.type === 'header') {
        headers[this.config.auth.name] = this.config.auth.value;
      }
    }

    // Build request body (exclude path/query params from body)
    let body: string | ReadableStream<Uint8Array> | undefined;
    let closeBodyStream: (() => void) | undefined;
    let needsDuplex = false;
    try {
      if (op.bodyKind === 'multipart') {
        const mp = await this.buildMultipartBody(op, toolCall.agentId, effectiveArgs, sessionId);
        headers['Content-Type'] = mp.contentType;
        headers['Content-Length'] = String(mp.contentLength);
        body = mp.stream;
        closeBodyStream = mp.close;
        needsDuplex = true;
      } else if (op.bodyKind === 'binary') {
        const binary = await this.buildBinaryBody(op, toolCall.agentId, effectiveArgs, sessionId);
        if (binary) {
          headers['Content-Type'] = binary.contentType;
          headers['Content-Length'] = String(binary.sizeBytes);
          body = binary.stream;
          closeBodyStream = binary.close;
          needsDuplex = true;
        }
      } else {
        if (op.bodyIsValue) {
          if (effectiveArgs.body !== undefined) body = JSON.stringify(effectiveArgs.body);
        } else if (op.hasBody) {
          const bodyArgs: Record<string, unknown> = {};
          const paramNames = new Set([...op.pathParams, ...op.queryParams]);
          for (const [key, value] of Object.entries(effectiveArgs)) {
            if (!paramNames.has(key)) {
              Object.defineProperty(bodyArgs, key, {
                value,
                enumerable: true,
                writable: true,
                configurable: true,
              });
            }
          }
          if (Object.keys(bodyArgs).length > 0) {
            body = JSON.stringify(bodyArgs);
          }
        }
      }
    } catch (err) {
      closeBodyStream?.();
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    // Execute request
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeout_ms);

    try {
      const fetchInit: RequestInit & { duplex?: 'half' } = {
        method: op.method.toUpperCase(),
        headers,
        body: ['post', 'put', 'patch'].includes(op.method) ? body : undefined,
        signal: controller.signal,
        redirect: 'manual',
      };
      if (needsDuplex && fetchInit.body) {
        fetchInit.duplex = 'half';
      } else if (!fetchInit.body) {
        closeBodyStream?.();
      }
      // Final synchronous re-check right before fetch so revocation during DNS host verification
      // or body setup cannot still dispatch buffered upload bytes upstream.
      if (uploadPlan && this.uploadStore) {
        assertUploadPlanActive(uploadPlan, toolCall.agentId, this.uploadStore, sessionId);
      }
      const response = await fetch(url, fetchInit);

      let responseBody = '';
      let truncated = false;
      const reader = response.body?.getReader();

      if (reader) {
        let bytesRead = 0;
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = (await reader.read()) as { done: boolean; value: Uint8Array };
          if (done) break;

          bytesRead += value.byteLength;
          if (bytesRead <= this.config.max_response_bytes) {
            responseBody += decoder.decode(value, { stream: true });
            continue;
          }

          const overshoot = bytesRead - this.config.max_response_bytes;
          const usable = value.byteLength - overshoot;
          if (usable > 0) {
            responseBody += decoder.decode(value.slice(0, usable), { stream: true });
          }
          truncated = true;
          void reader.cancel();
          break;
        }
        responseBody += decoder.decode();
      }

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      return {
        success: response.ok,
        data: {
          status: response.status,
          headers: responseHeaders,
          body: responseBody,
          truncated,
        },
        error: response.ok ? undefined : `HTTP ${response.status}: ${responseBody.slice(0, 200)}`,
      };
    } catch (err) {
      closeBodyStream?.();
      if ((err as Error).name === 'AbortError') {
        return { success: false, error: `Request timed out after ${this.config.timeout_ms}ms` };
      }
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      // Cleared only here so the deadline also covers reading the body, not just the headers.
      clearTimeout(timer);
    }
  }

  async stop(): Promise<void> {}

  private parseNativeUploadId(fieldName: string, raw: unknown): string {
    if (!this.uploadStore?.isEnabled()) {
      throw new Error(
        `Field "${fieldName}" requires staged file uploads (set uploads.enabled: true).`
      );
    }
    const parsed = parseUploadRef(raw);
    if (!parsed || parsed.mode) {
      throw new Error(
        `Field "${fieldName}" expects a bare Airlock upload ref ("airlock-upload://<id>") from airlock_prepare_upload.`
      );
    }
    return parsed.id;
  }

  private async buildMultipartBody(
    op: ParsedOperation,
    agentId: string,
    effectiveArgs: Record<string, unknown>,
    sessionId?: string
  ): Promise<StreamingMultipartBody> {
    const paramNames = new Set([...op.pathParams, ...op.queryParams]);
    const singleFiles = new Set(op.fileFields);
    const arrayFiles = new Set(op.arrayFileFields);
    const parts: MultipartFieldSpec[] = [];

    for (const [key, value] of Object.entries(effectiveArgs)) {
      if (paramNames.has(key) || value === undefined) continue;
      if (singleFiles.has(key)) {
        // Explicit null on a nullable OpenAPI 3.1 file field omits the optional file part.
        if (value === null) continue;
        parts.push({ kind: 'upload', name: key, uploadId: this.parseNativeUploadId(key, value) });
      } else if (arrayFiles.has(key)) {
        if (value === null) continue;
        const refs = Array.isArray(value) ? value : [value];
        for (const item of refs) {
          if (item === null || item === undefined) continue;
          parts.push({ kind: 'upload', name: key, uploadId: this.parseNativeUploadId(key, item) });
        }
      } else if (Array.isArray(value)) {
        for (const item of value) {
          parts.push({ kind: 'text', name: key, value: stringifyFormFieldValue(item) });
        }
      } else {
        parts.push({ kind: 'text', name: key, value: stringifyFormFieldValue(value) });
      }
    }

    if (!this.uploadStore) {
      // Allow multipart endpoints with only text fields (no file refs) even without an UploadStore.
      if (parts.some((part) => part.kind === 'upload')) {
        throw new Error(
          'Multipart file uploads require staged file uploads (uploads.enabled: true).'
        );
      }
      const { buildStreamingMultipartFromParts } = await import('../../uploads/store.js');
      return buildStreamingMultipartFromParts(parts);
    }
    return this.uploadStore.openStreamingMultipart(agentId, parts, sessionId);
  }

  private async buildBinaryBody(
    op: ParsedOperation,
    agentId: string,
    effectiveArgs: Record<string, unknown>,
    sessionId?: string
  ): Promise<
    | {
        stream: ReadableStream<Uint8Array>;
        contentType: string;
        sizeBytes: number;
        close: () => void;
      }
    | undefined
  > {
    const argName = op.binaryArgName ?? 'file';
    const raw = effectiveArgs[argName];
    if (raw === undefined || raw === null) return undefined;
    if (!this.uploadStore?.isEnabled()) {
      throw new Error(
        `Argument "${argName}" requires staged file uploads (set uploads.enabled: true).`
      );
    }
    const parsed = parseUploadRef(raw);
    if (!parsed || parsed.mode) {
      throw new Error(
        `Argument "${argName}" expects a bare Airlock upload ref ("airlock-upload://<id>") from airlock_prepare_upload.`
      );
    }
    const { record, stream, close } = await this.uploadStore.openVerifiedStream(
      agentId,
      parsed.id,
      sessionId
    );
    const contentType =
      record.contentType !== 'application/octet-stream'
        ? record.contentType
        : op.bodyContentType && !op.bodyContentType.includes('*')
          ? op.bodyContentType
          : 'application/octet-stream';
    return { stream, contentType, sizeBytes: record.sizeBytes, close };
  }
}
