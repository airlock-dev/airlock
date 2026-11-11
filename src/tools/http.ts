import { assertHostNotBlocked } from '../security/blocked-hosts.js';
import { isDomainAllowed } from '../security/domain-allowlist.js';
import type { AgentConfig, SecurityConfig } from '../config/schema.js';
import type { Tool } from '@modelcontextprotocol/server';

const MAX_RESPONSE_BYTES = 1_048_576; // 1MB default

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated?: boolean;
}

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export function buildHttpTools(): Tool[] {
  return HTTP_METHODS.map((method) => ({
    name: `http/${method}`,
    description: `HTTP ${method.toUpperCase()} request`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'Full URL' },
        headers: {
          type: 'object',
          description: 'Request headers',
          additionalProperties: { type: 'string' },
        },
        body: { type: 'string', description: 'Request body (for POST/PUT/PATCH)' },
        timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default 30000)' },
      },
      required: ['url'],
    },
  }));
}

export async function executeHttp(
  method: HttpMethod,
  args: Record<string, unknown>,
  agentConfig: AgentConfig,
  securityConfig: SecurityConfig
): Promise<HttpResult> {
  const url = args['url'] as string;
  const headers = (args['headers'] ?? {}) as Record<string, string>;
  const body = args['body'] as string | undefined;
  // The agent may ask for a shorter deadline, never a longer one than the operator configured.
  const requestedTimeout = args['timeout_ms'];
  const timeoutMs =
    typeof requestedTimeout === 'number' &&
    Number.isFinite(requestedTimeout) &&
    requestedTimeout > 0
      ? Math.min(requestedTimeout, agentConfig.http.timeout_ms)
      : agentConfig.http.timeout_ms;
  const maxBytes = agentConfig.http.max_response_bytes ?? MAX_RESPONSE_BYTES;

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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: method.toUpperCase(),
      headers,
      body: ['post', 'put', 'patch'].includes(method) ? body : undefined,
      signal: controller.signal,
      redirect: 'manual',
    });

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
    if ((err as Error).name === 'AbortError') {
      throw new Error(`HTTP request timed out after ${timeoutMs}ms`, { cause: err });
    }
    throw err;
  } finally {
    // Cleared only here so the deadline also covers reading the body, not just the headers.
    clearTimeout(timer);
  }
}
