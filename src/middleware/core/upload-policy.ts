import type { ValidateFunction } from 'ajv';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { isAirlockTool } from '../../airlock/tools.js';
import { buildEffectiveArgsForValidation, validateCallUploads } from '../../uploads/resolve.js';
import { evaluateArgPolicy, resolveArgPolicy } from './arg-policy.js';
import { formatSchemaValidationErrors } from './schema-validator.js';
import type { Middleware, ToolCallResponse } from '../types.js';

function uploadError(message: string): ToolCallResponse {
  return {
    result: { content: [{ type: 'text', text: message }], isError: true },
    text: message,
  };
}

/**
 * Validates and pins staged file upload references (`airlock-upload://<id>`) BEFORE detectors,
 * HITL approval, and execution.
 *
 * - Runs after allowlist, command-policy, schema-validator (which defers upload-bearing calls),
 *   and arg-policy so unauthorized calls fail fast.
 * - Validates effective substituted arguments with Ajv (keeping native binary/multipart handles
 *   intact) and re-checks `arg_policy` on effective arguments so neither schema rules nor argument
 *   policies can diverge from what downstream receives.
 * - Runs before detectors and hitl-gate so invalid/pending/disallowed uploads never generate human
 *   approval prompts, `:text` uploads are scanned by pre-execution detectors, approval prompts show
 *   verified size + SHA-256 (with declared/inferred filename and MIME), and approval grants are
 *   cryptographically bound to the validated digest, pointer location, and delivery mode.
 * - Keeps `ctx.args` compact (never injects megabytes of base64 into `ctx.args` or SQLite audit).
 */
export function uploadPolicyMiddleware(): Middleware {
  return async (ctx, next) => {
    // Airlock's own tools (e.g. airlock/request_approval) validate upload refs per planned call.
    if (isAirlockTool(ctx.toolName)) return next();

    const uploadStore = ctx.deps.uploadStore;
    const resolvedToolName =
      ctx.deps.registry.resolveToolName?.(ctx.toolName, ctx.agentId) ??
      ctx.agentConfig.tool_overrides?.[ctx.toolName]?.alias_of ??
      ctx.toolName;
    const backendKind =
      ctx.deps.registry.getToolBackendKind?.(ctx.toolName, ctx.agentId) ??
      inferBackendKind(resolvedToolName);
    const sessionId =
      typeof ctx.meta.downstreamSessionId === 'string' ? ctx.meta.downstreamSessionId : undefined;

    const validation = validateCallUploads({
      agentId: ctx.agentId,
      agentConfig: ctx.agentConfig,
      toolName: ctx.toolName,
      resolvedToolName,
      args: ctx.args,
      uploadStore,
      sessionId,
      backendKind,
      nativeUploadArgKind: (topKey) =>
        ctx.deps.registry.nativeUploadArgKind?.(ctx.toolName, topKey, ctx.agentId),
    });

    if (!validation.ok) {
      return uploadError(validation.error);
    }
    if (!validation.hasUploads || !uploadStore) {
      return next();
    }

    const release = uploadStore.pin(ctx.agentId, validation.seenIds, sessionId);
    try {
      const effective = await buildEffectiveArgsForValidation(
        ctx.args,
        ctx.agentId,
        validation.plan,
        uploadStore,
        sessionId
      );
      if (!effective.ok) {
        return uploadError(effective.error);
      }

      // Run deferred Ajv validation against effective arguments (native binary/multipart fields stay
      // represented by their validated handles; substituted fields carry their real values).
      const deferredValidator = ctx.meta.schemaValidator as ValidateFunction | undefined;
      if (deferredValidator && !deferredValidator(effective.effectiveArgs)) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Invalid arguments: ${formatSchemaValidationErrors(deferredValidator)}`
        );
      }

      // Defense-in-depth: verify arg_policy on effective arguments too.
      const argPolicy = resolveArgPolicy(ctx.agentConfig, ctx.toolName);
      const argViolation = evaluateArgPolicy(argPolicy, ctx.toolName, effective.effectiveArgs);
      if (argViolation) {
        return uploadError(argViolation);
      }

      ctx.meta.uploads = validation.auditUploads;
      ctx.meta.hitlArgs = validation.hitlArgs;
      ctx.meta.uploadFingerprintBindings = validation.fingerprintBindings;
      if (effective.detectorText) {
        ctx.meta.uploadTextForDetectors = effective.detectorText;
      }
      if (
        Object.keys(validation.plan.byPointer).length > 0 ||
        Object.keys(validation.plan.nativePointers).length > 0
      ) {
        ctx.meta.uploadPlan = validation.plan;
      }

      return await next();
    } finally {
      release();
    }
  };
}

function inferBackendKind(toolName: string): 'http' | 'exec' | 'mcp' {
  if (toolName.startsWith('http/')) return 'http';
  if (toolName.startsWith('exec/')) return 'exec';
  return 'mcp';
}
