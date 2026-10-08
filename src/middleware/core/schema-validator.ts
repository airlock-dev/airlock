import AjvModule from 'ajv';
import Ajv2019Module from 'ajv/dist/2019.js';
import Ajv2020Module from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { Middleware } from '../types.js';

interface SchemaCompiler {
  compile(schema: unknown): ValidateFunction;
}

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
// Handle both ESM default and CJS exports — Ajv uses CJS which can appear as { default: Ajv } in ESM
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv = (AjvModule as any).default ?? AjvModule;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv2019 = (Ajv2019Module as any).default ?? Ajv2019Module;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv2020 = (Ajv2020Module as any).default ?? Ajv2020Module;
const ajv: SchemaCompiler = new Ajv({ allErrors: true, strict: false });
const ajv2019: SchemaCompiler = new Ajv2019({ allErrors: true, strict: false });
const ajv2020: SchemaCompiler = new Ajv2020({ allErrors: true, strict: false });
const validatorCache = new Map<string, { schema: unknown; validate: ValidateFunction }>();
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

const JSON_SCHEMA_2020_12 = 'draft/2020-12/';
const JSON_SCHEMA_2019_09 = 'draft/2019-09/';

/**
 * MCP tool input schemas use JSON Schema 2020-12 by default. Keep matching
 * compilers for explicit 2019-09 and draft-07 declarations.
 */
function compilerFor(schema: unknown): SchemaCompiler {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return ajv2020;

  const declaredDialect = (schema as Record<string, unknown>).$schema;
  if (declaredDialect === undefined) return ajv2020;
  if (typeof declaredDialect === 'string' && declaredDialect.includes(JSON_SCHEMA_2020_12)) {
    return ajv2020;
  }
  if (typeof declaredDialect === 'string' && declaredDialect.includes(JSON_SCHEMA_2019_09)) {
    return ajv2019;
  }
  return ajv;
}

function validatorFor(cacheKey: string, schema: unknown): ValidateFunction {
  const cached = validatorCache.get(cacheKey);
  if (cached && cached.schema === schema) return cached.validate;

  const compiler = compilerFor(schema);
  const validate = compiler.compile(schema);
  validatorCache.set(cacheKey, { schema, validate });
  return validate;
}

function validationErrors(validate: ValidateFunction): string {
  return (
    (validate.errors ?? [])
      .map((error) => `${error.instancePath || '/'}: ${error.message ?? 'unknown error'}`)
      .join('; ') || 'Unknown validation error'
  );
}

export function schemaValidatorMiddleware(): Middleware {
  return async (ctx, next) => {
    const tools = ctx.deps.registry.getAllTools();
    const resolvedToolName =
      ctx.deps.registry.resolveToolName?.(ctx.toolName, ctx.agentId) ??
      ctx.agentConfig.tool_overrides?.[ctx.toolName]?.alias_of ??
      ctx.toolName;
    const tool =
      tools.find((candidate) => candidate.name === ctx.toolName) ??
      tools.find((candidate) => candidate.name === resolvedToolName);
    if (!tool) return next();

    const cacheKey = `${ctx.toolName}->${resolvedToolName}`;
    if (tool.inputSchema) {
      const validateInput = validatorFor(`input:${cacheKey}`, tool.inputSchema);
      if (!validateInput(ctx.args)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid arguments: ${validationErrors(validateInput)}`
        );
      }
    }

    const response = await next();
    if (!tool.outputSchema || !response.result || typeof response.result !== 'object') {
      return response;
    }

    const result = response.result as Record<string, unknown>;
    if (result.isError === true) return response;
    if (!result.structuredContent || typeof result.structuredContent !== 'object') {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Tool "${ctx.toolName}" declared an output schema but returned no structured content`
      );
    }

    const validateOutput = validatorFor(`output:${cacheKey}`, tool.outputSchema);
    if (!validateOutput(result.structuredContent)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid structured output: ${validationErrors(validateOutput)}`
      );
    }
    return response;
  };
}
