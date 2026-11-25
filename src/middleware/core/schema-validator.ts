import AjvModule from 'ajv';
import type { ValidateFunction } from 'ajv';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { isAirlockTool } from '../../airlock/tools.js';
import { findUploadRefs } from '../../uploads/refs.js';
import type { Middleware } from '../types.js';

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
// Handle both ESM default and CJS exports — Ajv uses CJS which can appear as { default: Ajv } in ESM
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true, strict: false });
// Keyed on the inputSchema object itself: a registry refresh replaces the tool objects, so a changed
// schema gets a fresh validator, and the old one is collected with the old schema.
const validatorCache = new WeakMap<object, ValidateFunction>();
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

export function compileSchemaValidator(schema: object): ValidateFunction {
  let validate = validatorCache.get(schema);
  if (!validate) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    validate = ajv.compile(schema) as ValidateFunction;
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
