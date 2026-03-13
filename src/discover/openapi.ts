import { parseOpenApiSpec } from '../backend/openapi/parser.js';
import type { ApiConfig } from '../config/schema.js';

export async function discoverOpenApi(
  specPath: string,
  options?: { baseUrl?: string; include?: string[]; exclude?: string[] },
): Promise<{ apis: Record<string, ApiConfig> }> {
  const parsed = await parseOpenApiSpec(specPath, {
    baseUrlOverride: options?.baseUrl,
    include: options?.include,
    exclude: options?.exclude,
  });

  // Derive a config key from the spec filename
  const key = specPath
    .split('/')
    .pop()
    ?.replace(/\.(json|yaml|yml)$/i, '')
    .replace(/[^a-zA-Z0-9]/g, '_') ?? 'api';

  return {
    apis: {
      [key]: {
        spec: specPath,
        base_url: parsed.baseUrl || undefined,
        timeout_ms: 30000,
        max_response_bytes: 1048576,
      },
    },
  };
}
