import AjvDraft07Module from 'ajv';
import Ajv2020Module from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';

interface SchemaCompiler {
  compile(schema: Record<string, unknown>): ValidateFunction;
}

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AjvDraft07Ctor = (AjvDraft07Module as any).default ?? AjvDraft07Module;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv2020Ctor = (Ajv2020Module as any).default ?? Ajv2020Module;

/**
 * MCP 2026-07-28 specifies JSON Schema 2020-12 as the default dialect when `$schema` is omitted,
 * while permitting explicit draft-07 schemas. Use Ajv2020 by default and dispatch draft-07 to
 * standard Ajv when `$schema` declares draft-07.
 */
const ajv2020: SchemaCompiler = new Ajv2020Ctor({ allErrors: true, strict: false });
const ajvDraft07: SchemaCompiler = new AjvDraft07Ctor({ allErrors: true, strict: false });
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

export type CompiledEventSchema = ValidateFunction;

export type CompileSchemaResult =
  | { ok: true; validate: CompiledEventSchema }
  | { ok: false; error: string };

function isDraft07Schema(schema: Record<string, unknown>): boolean {
  const dialect = schema.$schema;
  return typeof dialect === 'string' && /draft-0?7/i.test(dialect);
}

/** Compile an event `inputSchema` or `payloadSchema` at catalog ingestion time. */
export function compileEventSchema(schema: Record<string, unknown>): CompileSchemaResult {
  try {
    const engine = isDraft07Schema(schema) ? ajvDraft07 : ajv2020;
    const validate = engine.compile(schema);
    return { ok: true, validate };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function formatValidationErrors(validate: ValidateFunction): string {
  return (
    (validate.errors ?? [])
      .map((e) => `${e.instancePath || '/'}: ${e.message ?? 'unknown error'}`)
      .join('; ') || 'Unknown validation error'
  );
}
