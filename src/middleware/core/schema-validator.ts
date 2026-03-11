import AjvModule from 'ajv';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { Middleware } from '../types.js';

// Handle both ESM default and CJS exports
const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true, strict: false });
const validatorCache = new Map<string, ReturnType<typeof ajv.compile>>();

export function schemaValidatorMiddleware(): Middleware {
  return async (ctx, next) => {
    const tools = ctx.deps.registry.getAllTools();
    const tool = tools.find(t => t.name === ctx.toolName);
    if (!tool?.inputSchema) return next();

    const schemaKey = ctx.toolName;
    let validate = validatorCache.get(schemaKey);
    if (!validate) {
      validate = ajv.compile(tool.inputSchema);
      validatorCache.set(schemaKey, validate);
    }

    if (!validate(ctx.args)) {
      const errors = validate.errors?.map((e: any) =>
        `${e.instancePath || '/'}: ${e.message}`
      ).join('; ') ?? 'Unknown validation error';
      throw new McpError(ErrorCode.InvalidParams, `Invalid arguments: ${errors}`);
    }

    return next();
  };
}
