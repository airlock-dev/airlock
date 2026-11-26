import { Ajv } from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { isAirlockTool } from '../../airlock/tools.js';
import { findUploadRefs } from '../../uploads/refs.js';
import type { Middleware } from '../types.js';

interface SchemaCompiler {
  compile(schema: object): ValidateFunction;
  removeSchema(schemaKeyRef?: unknown): unknown;
}

// `addUsedSchema: false` + `removeSchema()` after each compilation keeps `$id`-bearing schemas
// isolated across provider refreshes without per-schema Ajv instantiation overhead or `_cache` leaks.
const ajvOptions = { allErrors: true, strict: false, addUsedSchema: false };
const ajvDraft07: SchemaCompiler = new Ajv(ajvOptions);
const ajv2019: SchemaCompiler = new Ajv2019(ajvOptions);
const ajv2020: SchemaCompiler = new Ajv2020(ajvOptions);

// Keyed on the inputSchema object itself: a registry refresh replaces the tool objects, so a changed
// schema gets a fresh validator, and the old one is collected with the old schema.
const validatorCache = new WeakMap<object, ValidateFunction>();

function selectCompiler(schema: object): { compiler: SchemaCompiler; normalizedSchema: object } {
  const rawUri = (schema as { $schema?: unknown }).$schema;
  if (typeof rawUri !== 'string') {
    return { compiler: ajvDraft07, normalizedSchema: schema };
  }
  const trimmed = rawUri.trim().replace(/#$/, '');
  if (/^https?:\/\/json-schema\.org\/draft\/2020-12\/schema$/i.test(trimmed)) {
    const normalizedSchema =
      rawUri === 'https://json-schema.org/draft/2020-12/schema' ||
      rawUri === 'https://json-schema.org/draft/2020-12/schema#'
        ? schema
        : { ...schema, $schema: 'https://json-schema.org/draft/2020-12/schema' };
    return { compiler: ajv2020, normalizedSchema };
  }
  if (/^https?:\/\/json-schema\.org\/draft\/2019-09\/schema$/i.test(trimmed)) {
    const normalizedSchema =
      rawUri === 'https://json-schema.org/draft/2019-09/schema' ||
      rawUri === 'https://json-schema.org/draft/2019-09/schema#'
        ? schema
        : { ...schema, $schema: 'https://json-schema.org/draft/2019-09/schema' };
    return { compiler: ajv2019, normalizedSchema };
  }
  if (/^https?:\/\/json-schema\.org\/draft-0?7\/schema$/i.test(trimmed)) {
    const normalizedSchema =
      rawUri === 'http://json-schema.org/draft-07/schema' ||
      rawUri === 'http://json-schema.org/draft-07/schema#'
        ? schema
        : { ...schema, $schema: 'http://json-schema.org/draft-07/schema#' };
    return { compiler: ajvDraft07, normalizedSchema };
  }
  return { compiler: ajvDraft07, normalizedSchema: schema };
}

export function compileSchemaValidator(schema: object): ValidateFunction {
  let validate = validatorCache.get(schema);
  if (!validate) {
    const { compiler, normalizedSchema } = selectCompiler(schema);
    try {
      validate = compiler.compile(normalizedSchema);
    } finally {
      // Evict compiled schema objects from Ajv's internal cache while preserving meta-schemas;
      // the returned `validate` function is already self-contained.
      compiler.removeSchema();
    }
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
