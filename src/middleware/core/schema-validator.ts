import AjvModule from 'ajv';
import type { ValidateFunction } from 'ajv';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { Middleware } from '../types.js';

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
// Handle both ESM default and CJS exports — Ajv uses CJS which can appear as { default: Ajv } in ESM
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true, strict: false });
const validatorCache = new Map<string, { schema: string; validate: ValidateFunction }>();
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

export function schemaValidatorMiddleware(): Middleware {
  return async (ctx, next) => {
    const tools = ctx.deps.registry.getAllTools();
    const resolvedToolName =
      ctx.deps.registry.resolveToolName?.(ctx.toolName, ctx.agentId) ??
      ctx.agentConfig.tool_overrides?.[ctx.toolName]?.alias_of ??
      ctx.toolName;
    const tool =
      tools.find((t) => t.name === ctx.toolName) ?? tools.find((t) => t.name === resolvedToolName);
    if (!tool?.inputSchema) return next();

    const cacheKey = `${ctx.toolName}->${resolvedToolName}`;
    // Keyed on the schema too: an upstream can change a tool's inputSchema on refresh, and a
    // validator compiled from the old one would keep rejecting (or accepting) the wrong shape.
    const schema = JSON.stringify(tool.inputSchema);
    let cached = validatorCache.get(cacheKey);
    if (!cached || cached.schema !== schema) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      cached = { schema, validate: ajv.compile(tool.inputSchema) as ValidateFunction };
      validatorCache.set(cacheKey, cached);
    }
    const validate = cached.validate;

    if (!validate(ctx.args)) {
      const errors =
        (validate.errors ?? [])
          .map((e) => `${e.instancePath || '/'}: ${e.message ?? 'unknown error'}`)
          .join('; ') || 'Unknown validation error';
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid arguments: ${errors}`);
    }

    return next();
  };
}
