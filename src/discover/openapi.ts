import { parseOpenApiSpec } from '../backend/openapi/parser.js';
import type { ApiConfig } from '../config/schema.js';

function deriveKeyFromPath(specPath: string): string {
  // Handle URLs: extract last meaningful path segment
  let filename: string;
  try {
    const url = new URL(specPath);
    // Use the last non-empty path segment before the filename
    const segments = url.pathname.split('/').filter(Boolean);
    // Skip generic filenames like "openapi.json", "swagger.json"
    const last = segments[segments.length - 1] ?? '';
    const stripped = last.replace(/\.(json|yaml|yml)$/i, '');
    if (/^(openapi|swagger|spec|api)$/i.test(stripped) && segments.length > 1) {
      filename = segments[segments.length - 2];
    } else {
      filename = stripped;
    }
  } catch {
    // Local file path
    filename =
      specPath
        .split('/')
        .pop()
        ?.replace(/\.(json|yaml|yml)$/i, '') ?? 'api';
  }
  return filename.replace(/[^a-zA-Z0-9]/g, '_') || 'api';
}

export async function discoverOpenApi(
  specPath: string,
  options?: { baseUrl?: string; include?: string[]; exclude?: string[] }
): Promise<{ apis: Record<string, ApiConfig> }> {
  const parsed = await parseOpenApiSpec(specPath, {
    baseUrlOverride: options?.baseUrl,
    include: options?.include,
    exclude: options?.exclude,
  });

  const key = deriveKeyFromPath(specPath);

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
