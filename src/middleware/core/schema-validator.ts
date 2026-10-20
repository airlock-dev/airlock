import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { Middleware } from '../types.js';

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
    const tool =
      tools.find((t) => t.name === ctx.toolName) ?? tools.find((t) => t.name === resolvedToolName);
    if (!tool?.inputSchema) return next();

    const schema = tool.inputSchema;
    let validate = validatorCache.get(schema);
    if (!validate) {
      // A provider refresh can return a new schema with the same $id (even a changed contract).
      // Keep AJV's registry scoped to this catalog schema: a global registry rejects duplicate
      // IDs and also retains obsolete schemas after our weak cache releases them.
      const options = { allErrors: true, strict: false };
      const compiler =
        schema.$schema === 'https://json-schema.org/draft/2020-12/schema'
          ? new Ajv2020(options)
          : new Ajv(options);
      validate = compiler.compile(schema);
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
