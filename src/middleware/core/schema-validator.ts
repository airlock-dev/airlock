import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { Middleware } from '../types.js';

const ajv = new Ajv({ allErrors: true, strict: false });
const ajv2020 = new Ajv2020({ allErrors: true, strict: false });
// Cache by the actual catalog schema, so a provider reconnect that changes its contract cannot
// keep validating new calls against an older schema for the same tool name.
const validatorCache = new WeakMap<object, ValidateFunction>();

export function schemaValidatorMiddleware(): Middleware {
  return async (ctx, next) => {
    const tools = ctx.deps.registry.getAllTools();
    const resolvedToolName =
      ctx.deps.registry.resolveToolName?.(ctx.toolName, ctx.agentId) ??
      ctx.agentConfig.tool_overrides?.[ctx.toolName]?.alias_of ??
      ctx.toolName;
    const tool = tools.find((t) => t.name === ctx.toolName) ?? tools.find((t) => t.name === resolvedToolName);
    if (!tool?.inputSchema) return next();

    const schema = tool.inputSchema;
    let validate = validatorCache.get(schema);
    if (!validate) {
      validate = (schema.$schema === 'https://json-schema.org/draft/2020-12/schema'
        ? ajv2020
        : ajv).compile(schema);
      validatorCache.set(schema, validate);
    }

    if (!validate(ctx.args)) {
      const errors =
        (validate.errors ?? [])
          .map((e) => `${e.instancePath || '/'}: ${e.message ?? 'unknown error'}`)
          .join('; ') || 'Unknown validation error';
      throw new McpError(ErrorCode.InvalidParams, `Invalid arguments: ${errors}`);
    }

    return next();
  };
}
