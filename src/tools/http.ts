import { isBlockedHost } from '../security/blocked-hosts.js';
import { isDomainAllowed } from '../security/domain-allowlist.js';
import type { AgentConfig, SecurityConfig } from '../config/schema.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

const MAX_RESPONSE_BYTES = 1_048_576; // 1MB default

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated?: boolean;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head'] as const;
type HttpMethod = typeof HTTP_METHODS[number];

export function buildHttpTools(): Tool[] {
  return HTTP_METHODS.map(method => ({
    name: `http/${method}`,
    description: `HTTP ${method.toUpperCase()} request`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        url:     { type: 'string', description: 'Full URL' },
        headers: { type: 'object', description: 'Request headers', additionalProperties: { type: 'string' } },
        body:    { type: 'string', description: 'Request body (for POST/PUT/PATCH)' },
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
  securityConfig: SecurityConfig,
): Promise<HttpResult> {
  const url = args['url'] as string;
  const headers = (args['headers'] ?? {}) as Record<string, string>;
  const body = args['body'] as string | undefined;
  const timeoutMs = (args['timeout_ms'] as number | undefined) ?? agentConfig.http.timeout_ms;
  const maxBytes = agentConfig.http.max_response_bytes ?? MAX_RESPONSE_BYTES;

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  // Security checks
  if (isBlockedHost(hostname, securityConfig.blocked_hosts, securityConfig.allowed_local)) {
    throw new Error(`Blocked host: ${hostname}`);
  }

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
    });

    clearTimeout(timer);

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => { responseHeaders[key] = value; });

    const buffer = await response.arrayBuffer();
    let bodyText: string;
    let truncated = false;

    if (buffer.byteLength > maxBytes) {
      bodyText = Buffer.from(buffer.slice(0, maxBytes)).toString('utf-8');
      truncated = true;
    } else {
      bodyText = Buffer.from(buffer).toString('utf-8');
    }

    return { status: response.status, headers: responseHeaders, body: bodyText, truncated };
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === 'AbortError') {
      throw new Error(`HTTP request timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}
