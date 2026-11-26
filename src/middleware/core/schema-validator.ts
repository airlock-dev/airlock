import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { isAirlockTool } from '../../airlock/tools.js';
import { findUploadRefs } from '../../uploads/refs.js';
import type { Middleware } from '../types.js';

// Keyed on the inputSchema object itself: a registry refresh replaces the tool objects, so a changed
// schema gets a fresh validator, and the old one is collected with the old schema.
const validatorCache = new WeakMap<object, ValidateFunction>();

export function compileSchemaValidator(schema: object): ValidateFunction {
  let validate = validatorCache.get(schema);
  if (!validate) {
    // A provider refresh can return a new schema with the same $id (even a changed contract).
    // Keep AJV's registry scoped to this catalog schema: a global registry rejects duplicate
    // IDs and also retains obsolete schemas after our weak cache releases them.
    const options = { allErrors: true, strict: false };
    const schemaUri = (schema as { $schema?: unknown }).$schema;
    const compiler =
      schemaUri === 'https://json-schema.org/draft/2020-12/schema'
        ? new Ajv2020(options)
        : new Ajv(options);
    validate = compiler.compile(schema);
    validatorCache.set(schema, validate);
  }
  return validate;
}

export function formatSchemaValidationErrors(validate: ValidateFunction): string {
  return (
    (validate.errors ?? [])
      .map((e) => `${e.instancePath || '/'}: ${e.message ?? 'unknown error'}`)
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
      tools.find((t) => t.name === ctx.toolName) ?? tools.find((t) => t.name === resolvedToolName);
    if (!tool?.inputSchema) return next();

    const validate = compileSchemaValidator(tool.inputSchema);

    // When a non-Airlock tool call carries staged upload refs, defer schema validation to
    // uploadPolicyMiddleware so Ajv validates the effective substituted arguments (while keeping
    // native file handles intact) instead of rejecting short/enum/pattern fields against raw
    // `airlock-upload://...` handles. Airlock's own tools (e.g. request_approval) skip
    // uploadPolicyMiddleware and validate planned calls individually, so validate their outer
    // schema immediately here.
    if (!isAirlockTool(ctx.toolName) && findUploadRefs(ctx.args).length > 0) {
      ctx.meta.schemaValidator = validate;
      return next();
    }

    if (!validate(ctx.args)) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Invalid arguments: ${formatSchemaValidationErrors(validate)}`
      );
    }

    return next();
  };
}
