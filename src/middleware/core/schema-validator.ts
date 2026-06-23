import AjvModule from 'ajv';
import type { ValidateFunction } from 'ajv';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { Middleware } from '../types.js';

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
// Handle both ESM default and CJS exports — Ajv uses CJS which can appear as { default: Ajv } in ESM
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true, strict: false });
const validatorCache = new Map<string, ValidateFunction>();
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

export function schemaValidatorMiddleware(): Middleware {
  return async (ctx, next) => {
    const tools = ctx.deps.registry.getAllTools();
    const resolvedToolName =
      ctx.deps.registry.resolveToolName?.(ctx.toolName, ctx.agentId) ??
      ctx.agentConfig.tool_overrides?.[ctx.toolName]?.alias_of ??
      ctx.toolName;
    const tool = tools.find((t) => t.name === ctx.toolName) ?? tools.find((t) => t.name === resolvedToolName);
    if (!tool?.inputSchema) return next();

    const cacheKey = `${ctx.toolName}->${resolvedToolName}`;
    let validate = validatorCache.get(cacheKey);
    if (!validate) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      validate = ajv.compile(tool.inputSchema) as ValidateFunction;
      validatorCache.set(cacheKey, validate);
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
