import SwaggerParser from '@apidevtools/swagger-parser';
import type { OpenAPI, OpenAPIV3 } from 'openapi-types';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export interface ParsedOperation {
  name: string;
  method: string;
  path: string;
  description?: string;
  inputSchema: Tool['inputSchema'];
  pathParams: string[];
  queryParams: string[];
  hasBody: boolean;
}

export interface ParsedApi {
  baseUrl: string;
  operations: ParsedOperation[];
}

function isV3Document(doc: OpenAPI.Document): doc is OpenAPIV3.Document {
  return 'openapi' in doc;
}

function generateToolName(method: string, path: string, operationId?: string): string {
  if (operationId) {
    return operationId.replace(/[^a-zA-Z0-9_]/g, '_');
  }
  // Strip common prefixes
  let cleanPath = path.replace(/^\/(v\d+|api)\//i, '/');
  // Convert path to name: /pets/{petId} -> pets_by_petId
  const parts = cleanPath.split('/').filter(Boolean).map(p => {
    if (p.startsWith('{') && p.endsWith('}')) {
      return 'by_' + p.slice(1, -1);
    }
    return p;
  });
  return `${method}_${parts.join('_')}`;
}

function matchesFilter(method: string, path: string, filters: string[]): boolean {
  const entry = `${method.toUpperCase()} ${path}`;
  return filters.some(f => {
    if (f.includes('*')) {
      const regex = new RegExp('^' + f.replace(/\*/g, '.*') + '$');
      return regex.test(entry);
    }
    return entry === f;
  });
}

function schemaToJsonSchema(schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject | undefined): Record<string, unknown> {
  if (!schema) return { type: 'string' };
  if ('$ref' in schema) return { type: 'string' }; // should be dereferenced already
  const result: Record<string, unknown> = {};
  if (schema.type) result.type = schema.type;
  if (schema.description) result.description = schema.description;
  if (schema.enum) result.enum = schema.enum;
  if (schema.default !== undefined) result.default = schema.default;
  return result;
}

export async function parseOpenApiSpec(
  specPath: string,
  options?: { include?: string[]; exclude?: string[]; baseUrlOverride?: string },
): Promise<ParsedApi> {
  const api = await SwaggerParser.dereference(specPath) as OpenAPIV3.Document;

  if (!isV3Document(api)) {
    throw new Error('Only OpenAPI 3.x specs are supported');
  }

  // Determine base URL
  let baseUrl = options?.baseUrlOverride ?? '';
  if (!baseUrl && api.servers?.length) {
    baseUrl = api.servers[0].url;
  }

  const operations: ParsedOperation[] = [];

  for (const [path, pathItem] of Object.entries(api.paths ?? {})) {
    if (!pathItem) continue;

    for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
      const operation = (pathItem as Record<string, unknown>)[method] as OpenAPIV3.OperationObject | undefined;
      if (!operation) continue;

      // Apply include/exclude filters
      if (options?.include && !matchesFilter(method, path, options.include)) continue;
      if (options?.exclude && matchesFilter(method, path, options.exclude)) continue;

      const name = generateToolName(method, path, operation.operationId);
      const pathParams: string[] = [];
      const queryParams: string[] = [];
      const properties: Record<string, object> = {};
      const required: string[] = [];

      // Parse parameters
      const allParams = [
        ...((pathItem as OpenAPIV3.PathItemObject).parameters ?? []),
        ...(operation.parameters ?? []),
      ] as OpenAPIV3.ParameterObject[];

      for (const param of allParams) {
        if (param.in === 'path') {
          pathParams.push(param.name);
          properties[param.name] = {
            ...schemaToJsonSchema(param.schema as OpenAPIV3.SchemaObject),
            description: param.description,
          };
          required.push(param.name);
        } else if (param.in === 'query') {
          queryParams.push(param.name);
          properties[param.name] = {
            ...schemaToJsonSchema(param.schema as OpenAPIV3.SchemaObject),
            description: param.description,
          };
          if (param.required) required.push(param.name);
        }
      }

      // Parse request body
      const hasBody = !!operation.requestBody;
      if (hasBody) {
        const requestBody = operation.requestBody as OpenAPIV3.RequestBodyObject;
        const content = requestBody?.content?.['application/json'];
        if (content?.schema) {
          const bodySchema = content.schema as OpenAPIV3.SchemaObject;
          if (bodySchema.type === 'object' && bodySchema.properties) {
            for (const [propName, propSchema] of Object.entries(bodySchema.properties)) {
              properties[propName] = schemaToJsonSchema(propSchema as OpenAPIV3.SchemaObject);
            }
            if (bodySchema.required) {
              required.push(...bodySchema.required);
            }
          } else {
            // Non-object body — accept as single "body" field
            properties['body'] = schemaToJsonSchema(bodySchema);
          }
        }
      }

      operations.push({
        name,
        method,
        path,
        description: operation.summary ?? operation.description,
        inputSchema: {
          type: 'object' as const,
          properties,
          ...(required.length > 0 ? { required } : {}),
        },
        pathParams,
        queryParams,
        hasBody,
      });
    }
  }

  return { baseUrl, operations };
}
