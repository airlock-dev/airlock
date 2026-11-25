import SwaggerParser from '@apidevtools/swagger-parser';
import type { OpenAPI, OpenAPIV3 } from 'openapi-types';
import type { Tool } from '@modelcontextprotocol/server';

export type OpenApiBodyKind = 'none' | 'json' | 'multipart' | 'binary';

export interface ParsedOperation {
  name: string;
  method: string;
  path: string;
  description?: string;
  inputSchema: Tool['inputSchema'];
  pathParams: string[];
  queryParams: string[];
  hasBody: boolean;
  bodyKind: OpenApiBodyKind;
  bodyContentType?: string;
  /** Multipart form fields accepting a single `airlock-upload://<id>` ref. */
  fileFields: string[];
  /** Multipart form fields accepting an array of `airlock-upload://<id>` refs. */
  arrayFileFields: string[];
  /** Argument name carrying the `airlock-upload://<id>` ref for raw binary request bodies. */
  binaryArgName?: string;
  /**
   * The JSON body is not an object, so it is taken whole from the single `body` argument rather
   * than assembled from the remaining arguments.
   */
  bodyIsValue: boolean;
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
  const cleanPath = path.replace(/^\/(v\d+|api)\//i, '/');
  // Convert path to name: /pets/{petId} -> pets_by_petId
  const parts = cleanPath
    .split('/')
    .filter(Boolean)
    .map((p) => {
      if (p.startsWith('{') && p.endsWith('}')) {
        return 'by_' + p.slice(1, -1);
      }
      return p;
    });
  return `${method}_${parts.join('_')}`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesFilter(method: string, path: string, filters: string[]): boolean {
  const entry = `${method.toUpperCase()} ${path}`;
  return filters.some((f) => {
    if (f.includes('*')) {
      // Split on *, escape each literal segment, rejoin with .*
      const pattern = f.split('*').map(escapeRegex).join('.*');
      const regex = new RegExp('^' + pattern + '$');
      return regex.test(entry);
    }
    return entry === f;
  });
}

const UPLOAD_REF_HINT =
  'Pass an Airlock upload ref ("airlock-upload://<id>") from airlock_prepare_upload.';

type ExtendedSchemaObject = OpenAPIV3.SchemaObject & {
  contentMediaType?: string;
  contentEncoding?: string;
};

function isBinarySchema(
  schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject | undefined
): boolean {
  if (!schema || '$ref' in schema) return false;
  const extended = schema as ExtendedSchemaObject;
  if (
    extended.format === 'binary' ||
    extended.contentEncoding === 'binary' ||
    Boolean(extended.contentMediaType)
  ) {
    return true;
  }
  const branches = [...(extended.anyOf ?? []), ...(extended.oneOf ?? [])];
  return branches.some((branch) => isBinarySchema(branch));
}

function isNullableSchema(
  schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject | undefined
): boolean {
  if (!schema || '$ref' in schema) return false;
  if (schema.nullable === true) return true;
  const rawType = schema.type as unknown;
  if (Array.isArray(rawType) && rawType.includes('null')) return true;
  const branches = [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])];
  return branches.some((branch) => {
    if (!branch || '$ref' in branch) return false;
    return (branch.type as unknown) === 'null' || isNullableSchema(branch);
  });
}

function isBinaryArraySchema(
  schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject | undefined
): boolean {
  if (!schema || '$ref' in schema) return false;
  const rawType = schema.type as unknown;
  const isArrayType = rawType === 'array' || (Array.isArray(rawType) && rawType.includes('array'));
  if (isArrayType && 'items' in schema) {
    return isBinarySchema(schema.items);
  }
  const branches = [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])];
  return branches.some((branch) => isBinaryArraySchema(branch));
}

function isBinaryMediaType(
  mediaType: string,
  schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject | undefined
): boolean {
  const normalized = mediaType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (
    normalized === 'application/octet-stream' ||
    normalized === 'application/pdf' ||
    normalized === 'application/zip' ||
    normalized.startsWith('image/') ||
    normalized.startsWith('audio/') ||
    normalized.startsWith('video/') ||
    normalized.startsWith('model/')
  ) {
    return true;
  }
  return isBinarySchema(schema);
}

function withUploadHint(description?: string): string {
  return description ? `${description} ${UPLOAD_REF_HINT}` : UPLOAD_REF_HINT;
}

function schemaToJsonSchema(
  schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject | undefined
): Record<string, unknown> {
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
  options?: { include?: string[]; exclude?: string[]; baseUrlOverride?: string }
): Promise<ParsedApi> {
  const api = await SwaggerParser.dereference(specPath);

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
      const operation = (pathItem as Record<string, unknown>)[method] as
        | OpenAPIV3.OperationObject
        | undefined;
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
      let bodyKind: OpenApiBodyKind = 'none';
      let bodyContentType: string | undefined;
      const fileFields: string[] = [];
      const arrayFileFields: string[] = [];
      let binaryArgName: string | undefined;
      let bodyIsValue = false;

      if (hasBody) {
        const requestBody = operation.requestBody as OpenAPIV3.RequestBodyObject;
        const contentMap = requestBody?.content ?? {};
        const jsonContent = contentMap['application/json'];
        const multipartContent = contentMap['multipart/form-data'];

        if (jsonContent) {
          bodyKind = 'json';
          bodyContentType = 'application/json';
          if (jsonContent.schema) {
            const bodySchema = jsonContent.schema as OpenAPIV3.SchemaObject;
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
              bodyIsValue = true;
            }
          }
        } else if (multipartContent) {
          bodyKind = 'multipart';
          bodyContentType = 'multipart/form-data';
          if (multipartContent.schema) {
            const bodySchema = multipartContent.schema as OpenAPIV3.SchemaObject;
            if (bodySchema.properties) {
              for (const [propName, propSchema] of Object.entries(bodySchema.properties)) {
                const typedProp = propSchema as OpenAPIV3.SchemaObject;
                if (isBinarySchema(typedProp)) {
                  fileFields.push(propName);
                  properties[propName] = isNullableSchema(typedProp)
                    ? {
                        anyOf: [{ type: 'string' }, { type: 'null' }],
                        description: withUploadHint(typedProp.description),
                      }
                    : {
                        type: 'string',
                        description: withUploadHint(typedProp.description),
                      };
                } else if (isBinaryArraySchema(typedProp)) {
                  arrayFileFields.push(propName);
                  properties[propName] = isNullableSchema(typedProp)
                    ? {
                        anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }],
                        description: withUploadHint(typedProp.description),
                      }
                    : {
                        type: 'array',
                        items: { type: 'string' },
                        description: withUploadHint(typedProp.description),
                      };
                } else {
                  properties[propName] = schemaToJsonSchema(typedProp);
                }
              }
              if (bodySchema.required) {
                required.push(...bodySchema.required);
              }
            }
          }
        } else {
          const binaryEntry = Object.entries(contentMap).find(([mediaType, mediaObj]) =>
            isBinaryMediaType(mediaType, mediaObj?.schema)
          );
          if (binaryEntry) {
            const [mediaType, mediaObj] = binaryEntry;
            bodyKind = 'binary';
            bodyContentType = mediaType;
            binaryArgName = !Object.prototype.hasOwnProperty.call(properties, 'file')
              ? 'file'
              : 'body';
            const schemaDesc =
              mediaObj?.schema && !('$ref' in mediaObj.schema)
                ? mediaObj.schema.description
                : undefined;
            properties[binaryArgName] = {
              type: 'string',
              description: withUploadHint(schemaDesc ?? requestBody.description),
            };
            if (requestBody.required) {
              required.push(binaryArgName);
            }
          } else {
            bodyKind = 'json';
            bodyContentType = 'application/json';
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
          properties: properties as NonNullable<Tool['inputSchema']['properties']>,
          ...(required.length > 0 ? { required } : {}),
        },
        pathParams,
        queryParams,
        hasBody,
        bodyKind,
        ...(bodyContentType ? { bodyContentType } : {}),
        fileFields,
        arrayFileFields,
        ...(binaryArgName ? { binaryArgName } : {}),
        bodyIsValue,
      });
    }
  }

  return { baseUrl, operations };
}
