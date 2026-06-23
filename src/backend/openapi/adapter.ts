import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { BackendAdapter } from '../types.js';
import type { ToolCall, ToolResult } from '../../types.js';
import type { ApiConfig, SecurityConfig } from '../../config/schema.js';
import { parseOpenApiSpec, type ParsedApi, type ParsedOperation } from './parser.js';
import { assertHostNotBlocked } from '../../security/blocked-hosts.js';
import { childLogger } from '../../util/logger.js';

const log = childLogger('openapi-adapter');

export class OpenApiAdapter implements BackendAdapter {
  readonly id: string;
  private parsedApi?: ParsedApi;
  private operationMap = new Map<string, ParsedOperation>();

  constructor(
    private configKey: string,
    private config: ApiConfig,
    private security: SecurityConfig,
  ) {
    this.id = `api:${configKey}`;
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

    // Build URL
    let url = this.parsedApi!.baseUrl + op.path;

    // Replace path params
    for (const paramName of op.pathParams) {
      const value = toolCall.args[paramName];
      if (value === undefined) {
        return { success: false, error: `Missing required path parameter: ${paramName}` };
      }
      url = url.replace(`{${paramName}}`, encodeURIComponent(String(value)));
    }

    // Add query params
    const queryParts: string[] = [];
    for (const paramName of op.queryParams) {
      const value = toolCall.args[paramName];
      if (value !== undefined) {
        queryParts.push(`${encodeURIComponent(paramName)}=${encodeURIComponent(String(value))}`);
      }
    }
    if (queryParts.length > 0) {
      url += '?' + queryParts.join('&');
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
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.auth) {
      if (this.config.auth.type === 'bearer') {
        headers['Authorization'] = `Bearer ${this.config.auth.token}`;
      } else if (this.config.auth.type === 'header') {
        headers[this.config.auth.name] = this.config.auth.value;
      }
    }

    // Build request body (exclude path/query params from body)
    let body: string | undefined;
    if (op.hasBody) {
      const bodyArgs: Record<string, unknown> = {};
      const paramNames = new Set([...op.pathParams, ...op.queryParams]);
      for (const [key, value] of Object.entries(toolCall.args)) {
        if (!paramNames.has(key)) {
          bodyArgs[key] = value;
        }
      }
      if (Object.keys(bodyArgs).length > 0) {
        body = JSON.stringify(bodyArgs);
      }
    }

    // Execute request
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeout_ms);

    try {
      const response = await fetch(url, {
        method: op.method.toUpperCase(),
        headers,
        body: ['post', 'put', 'patch'].includes(op.method) ? body : undefined,
        signal: controller.signal,
        redirect: 'manual',
      });

      clearTimeout(timer);

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
      response.headers.forEach((value, key) => { responseHeaders[key] = value; });

      return {
        success: response.ok,
        data: {
          status: response.status,
          headers: responseHeaders,
          body: responseBody,
        },
        error: response.ok ? undefined : `HTTP ${response.status}: ${responseBody.slice(0, 200)}`,
        metadata: { truncated },
      };
    } catch (err) {
      clearTimeout(timer);
      if ((err as Error).name === 'AbortError') {
        return { success: false, error: `Request timed out after ${this.config.timeout_ms}ms` };
      }
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async stop(): Promise<void> {}
}
