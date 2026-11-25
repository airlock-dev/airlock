import { createHash } from 'crypto';
import type { ValidateFunction } from 'ajv';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type {
  AgentConfig,
  ToolArgConstraintConfig,
  ToolUploadArgConfig,
  UploadDeliveryMode,
  UploadsConfig,
} from '../config/schema.js';
import { fingerprintCall } from '../hitl/grants.js';
import { resolveArgPolicy } from '../middleware/core/arg-policy.js';
import { resolveToolCommandPolicy } from '../middleware/core/command-policy.js';
import { formatSchemaValidationErrors } from '../middleware/core/schema-validator.js';
import { stableStringify } from '../util/stable-json.js';
import { effectiveMaxFileBytes, type UploadStore } from './store.js';
import {
  annotateUploadArgs,
  encodeJsonPointer,
  findUploadRefs,
  formatByteSize,
  matchesMimeAllowlist,
  replaceUploadRefs,
  type ParsedUploadRef,
} from './refs.js';

export type ResolvedDeliveryKind = UploadDeliveryMode | 'binary' | 'multipart';

export interface ResolvedUploadPlanEntry {
  pointer: string;
  argPath: string;
  uploadId: string;
  mode: UploadDeliveryMode;
  pathPrefix?: string;
}

export interface AuditUploadSummary {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  mode: ResolvedDeliveryKind;
}

export interface UploadExecutionPlan {
  /** Keyed by RFC 6901 JSON Pointer (collision-free even for keys containing `.` or `[`). */
  byPointer: Record<string, ResolvedUploadPlanEntry>;
  /**
   * Native binary/multipart upload handles validated at these RFC 6901 pointers. Materialization
   * preserves these handles verbatim so native HTTP/OpenAPI body builders stream them directly.
   */
  nativePointers: Record<string, string>;
}

/**
 * Cryptographic binding included in HITL approval fingerprints so a grant approved for one staged
 * upload ref is strictly tied to the validated file digest, pointer location, and delivery mode.
 */
export interface UploadFingerprintBinding {
  pointer: string;
  id: string;
  sha256: string;
  mode: ResolvedDeliveryKind;
  pathPrefix?: string;
}

export interface ValidateCallUploadsInput {
  agentId: string;
  agentConfig: AgentConfig;
  toolName: string;
  resolvedToolName: string;
  args: Record<string, unknown>;
  uploadStore?: UploadStore;
  sessionId?: string;
  backendKind?: 'mcp' | 'http' | 'api' | 'cli' | 'exec' | 'airlock';
  nativeUploadArgKind?: (topKey: string) => 'binary' | 'multipart' | undefined;
}

export type ValidateCallUploadsResult =
  | { ok: true; hasUploads: false }
  | {
      ok: true;
      hasUploads: true;
      plan: UploadExecutionPlan;
      auditUploads: AuditUploadSummary[];
      seenIds: string[];
      hitlArgs: Record<string, unknown>;
      fingerprintBindings: UploadFingerprintBinding[];
    }
  | { ok: false; error: string };

const INLINE_MODES = new Set<UploadDeliveryMode>(['base64', 'data_uri', 'text']);
const MAX_UPLOAD_REFS_PER_CALL = 50;

export function fingerprintCallWithUploads(
  tool: string,
  args: Record<string, unknown>,
  bindings?: UploadFingerprintBinding[]
): string {
  if (!bindings || bindings.length === 0) {
    return fingerprintCall(tool, args);
  }
  const sorted = [...bindings].sort((a, b) => a.pointer.localeCompare(b.pointer));
  return createHash('sha256')
    .update(tool)
    .update('\0')
    .update(stableStringify(args))
    .update('\0uploads\0')
    .update(stableStringify(sorted))
    .digest('hex');
}

/**
 * Match a ref's segment list against an `arg_policy` path using the exact same implicit array
 * unwrapping semantics as `resolvePath` in `src/middleware/core/arg-policy.ts`.
 */
function argPolicySegmentsOverlap(
  refSegments: ReadonlyArray<string | number>,
  constraintPath: string
): boolean {
  const refKeys = refSegments.filter((seg): seg is string => typeof seg === 'string');
  const constraintKeys = constraintPath
    .split('.')
    .filter(Boolean)
    .map((seg) => (seg.endsWith('[]') ? seg.slice(0, -2) : seg));
  if (refKeys.length === 0 || constraintKeys.length === 0) return false;
  const minLen = Math.min(refKeys.length, constraintKeys.length);
  for (let i = 0; i < minLen; i += 1) {
    if (refKeys[i] !== constraintKeys[i]) return false;
  }
  return true;
}

function isConstrainedByArgPolicy(
  policy: Record<string, ToolArgConstraintConfig[]>,
  refSegments: ReadonlyArray<string | number>
): boolean {
  for (const [argName, constraints] of Object.entries(policy)) {
    for (const constraint of constraints) {
      if (constraint.path) {
        if (argPolicySegmentsOverlap(refSegments, constraint.path)) return true;
      } else if (refSegments[0] === argName) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Parse a `tool_overrides.<tool>.uploads` pattern key into structured match tokens so a literal
 * JSON key containing `.` or `[` cannot steal a mapping intended for a nested property.
 *
 * - Keys starting with `/` are matched as exact RFC 6901 JSON Pointers (e.g. `"/a.b"`).
 * - Other keys are parsed as dotted/bracketed paths (`files[0].data`, `files[].data`, `content`).
 */
type RuleSegment =
  | { kind: 'key'; value: string }
  | { kind: 'index'; value: number }
  | { kind: 'anyIndex' };

function parseRuleSegments(ruleKey: string): RuleSegment[] | undefined {
  const tokens: RuleSegment[] = [];
  for (const part of ruleKey.split('.')) {
    if (!part) return undefined;
    const match = /^([^[]+)((?:\[(?:\d*)\])*)$/.exec(part);
    if (!match) return undefined;
    tokens.push({ kind: 'key', value: match[1] });
    if (match[2]) {
      const brackets = match[2].match(/\[(\d*)\]/g) ?? [];
      for (const b of brackets) {
        const inner = b.slice(1, -1);
        if (inner === '') {
          tokens.push({ kind: 'anyIndex' });
        } else {
          tokens.push({ kind: 'index', value: Number(inner) });
        }
      }
    }
  }
  return tokens;
}

function segmentsMatchRule(
  segments: ReadonlyArray<string | number>,
  ruleTokens: RuleSegment[]
): boolean {
  if (segments.length !== ruleTokens.length) return false;
  for (let i = 0; i < segments.length; i += 1) {
    const actual = segments[i];
    const expected = ruleTokens[i];
    if (expected.kind === 'key') {
      if (typeof actual !== 'string' || actual !== expected.value) return false;
    } else if (expected.kind === 'index') {
      if (typeof actual !== 'number' || actual !== expected.value) return false;
    } else {
      if (typeof actual !== 'number') return false;
    }
  }
  return true;
}

function estimatedInlineLength(
  sizeBytes: number,
  contentType: string,
  mode: UploadDeliveryMode
): number {
  if (mode === 'base64') return Math.ceil(sizeBytes / 3) * 4;
  if (mode === 'data_uri') {
    return `data:${contentType};base64,`.length + Math.ceil(sizeBytes / 3) * 4;
  }
  return sizeBytes;
}

export function effectiveAllowedModes(
  globalConfig: UploadsConfig,
  agentConfig: AgentConfig
): UploadDeliveryMode[] {
  const agentModes = agentConfig.uploads?.allowed_modes;
  if (!agentModes) return globalConfig.allowed_modes;
  return agentModes;
}

export function effectiveMaxInlineBytes(
  globalConfig: UploadsConfig,
  agentConfig: AgentConfig
): number {
  const globalCap = Math.min(globalConfig.max_inline_bytes, globalConfig.max_file_bytes);
  const agentCap = agentConfig.uploads?.max_inline_bytes;
  if (agentCap === undefined) return globalCap;
  return Math.min(globalCap, agentCap);
}

export function resolveToolUploadRules(
  agentConfig: AgentConfig,
  toolName: string,
  resolvedToolName: string
): Record<string, ToolUploadArgConfig> {
  const base =
    resolvedToolName !== toolName
      ? agentConfig.tool_overrides?.[resolvedToolName]?.uploads
      : undefined;
  const specific = agentConfig.tool_overrides?.[toolName]?.uploads;
  if (!base && !specific) return {};
  return { ...(base ?? {}), ...(specific ?? {}) };
}

/**
 * Look up a configured `tool_overrides.<tool>.uploads` entry for an exact segment path without
 * conflating literal keys containing `.` or `[` with nested object/array paths.
 */
export function matchToolUploadRule(
  rules: Record<string, ToolUploadArgConfig>,
  segments: ReadonlyArray<string | number>,
  pointer = encodeJsonPointer(segments)
): ToolUploadArgConfig | undefined {
  // 1. Explicit RFC 6901 JSON Pointer rule (e.g. "/a.b" or "/files/0/data")
  if (Object.prototype.hasOwnProperty.call(rules, pointer)) {
    return rules[pointer];
  }

  // 2. Segment-matched dotted/array rule (exact index beats wildcard `[]`)
  let wildcardMatch: ToolUploadArgConfig | undefined;
  for (const [ruleKey, rule] of Object.entries(rules)) {
    if (ruleKey.startsWith('/')) continue;
    const parsed = parseRuleSegments(ruleKey);
    if (!parsed) continue;
    if (segmentsMatchRule(segments, parsed)) {
      if (!parsed.some((tok) => tok.kind === 'anyIndex')) {
        return rule;
      }
      wildcardMatch ??= rule;
    }
  }
  if (wildcardMatch) return wildcardMatch;

  // 3. Top-level ordinary array container rule (e.g. `files: base64` matching `files[0]`).
  // Never match explicit `/...` JSON Pointer rules here.
  if (segments.length === 2 && typeof segments[0] === 'string' && typeof segments[1] === 'number') {
    for (const [ruleKey, rule] of Object.entries(rules)) {
      if (ruleKey.startsWith('/')) continue;
      const parsed = parseRuleSegments(ruleKey);
      if (
        parsed &&
        parsed.length === 1 &&
        parsed[0]?.kind === 'key' &&
        parsed[0].value === segments[0]
      ) {
        return rule;
      }
    }
  }

  return undefined;
}

export function validateUploadMimeForAgent(
  contentType: string,
  globalConfig: UploadsConfig,
  agentConfig: AgentConfig
): string | undefined {
  if (!matchesMimeAllowlist(contentType, globalConfig.allowed_mime_types)) {
    return `Uploaded file MIME type "${contentType}" is not permitted by gateway upload policy.`;
  }
  const agentMimes = agentConfig.uploads?.allowed_mime_types;
  if (agentMimes && agentMimes.length > 0 && !matchesMimeAllowlist(contentType, agentMimes)) {
    return `Uploaded file MIME type "${contentType}" is not permitted by agent upload policy.`;
  }
  return undefined;
}

export function isInlineDeliveryMode(mode: UploadDeliveryMode): boolean {
  return INLINE_MODES.has(mode);
}

export function describeUploadForHitl(record: {
  filename: string;
  sizeBytes: number;
  contentType: string;
  sha256: string;
}): string {
  const shortHash = record.sha256.slice(0, 12);
  return `${record.filename}, ${formatByteSize(record.sizeBytes)}, ${record.contentType}, sha256:${shortHash}`;
}

export function validateCallUploads(input: ValidateCallUploadsInput): ValidateCallUploadsResult {
  const found = findUploadRefs(input.args);
  if (found.length === 0) return { ok: true, hasUploads: false };

  const { uploadStore, agentId, agentConfig, toolName, resolvedToolName, sessionId, backendKind } =
    input;
  if (!uploadStore?.isEnabled() || agentConfig.uploads?.enabled === false) {
    return {
      ok: false,
      error: `Tool call "${toolName}" contains an airlock-upload:// reference, but staged file uploads are disabled.`,
    };
  }

  if (backendKind === 'exec') {
    return {
      ok: false,
      error: 'Staged upload references cannot be substituted into raw shell exec/run commands.',
    };
  }

  if (found.length > MAX_UPLOAD_REFS_PER_CALL) {
    return {
      ok: false,
      error: `Tool call "${toolName}" references ${found.length} staged uploads (maximum ${MAX_UPLOAD_REFS_PER_CALL} per call).`,
    };
  }

  const globalConfig = uploadStore.getConfig();
  const commandPolicy = resolveToolCommandPolicy(agentConfig, toolName, resolvedToolName);
  const argPolicy = resolveArgPolicy(agentConfig, toolName);
  const toolRules = resolveToolUploadRules(agentConfig, toolName, resolvedToolName);
  const allowedModes = effectiveAllowedModes(globalConfig, agentConfig);
  const maxFileBytes = effectiveMaxFileBytes(globalConfig, agentConfig.uploads);
  const maxInlineBytes = effectiveMaxInlineBytes(globalConfig, agentConfig);
  // Allow one full maxInlineBytes file after base64/data_uri expansion while capping total
  // aggregate materialized string memory across repeated references in a single call.
  const maxAggregateInlineChars = Math.ceil((maxInlineBytes * 4) / 3) + 128;

  const plan: UploadExecutionPlan = { byPointer: {}, nativePointers: {} };
  const auditUploads: AuditUploadSummary[] = [];
  const seenIds = new Set<string>();
  const descriptionsById = new Map<string, string>();
  const fingerprintBindings: UploadFingerprintBinding[] = [];
  let aggregateInlineChars = 0;
  let aggregateNativeBytes = 0;

  for (const refEntry of found) {
    if (!refEntry.parsed) {
      return {
        ok: false,
        error: `Invalid upload reference at "${refEntry.path}": "${refEntry.value}". Expected "airlock-upload://<upload_id>" (optionally with ":base64", ":data_uri", ":text", ":path", or ":url").`,
      };
    }

    if (commandPolicy && Object.prototype.hasOwnProperty.call(commandPolicy, refEntry.topKey)) {
      return {
        ok: false,
        error: `Staged upload references cannot be substituted into command_policy-controlled argument "${refEntry.topKey}" on "${toolName}".`,
      };
    }

    if (isConstrainedByArgPolicy(argPolicy, refEntry.segments)) {
      return {
        ok: false,
        error: `Staged upload references cannot be substituted into arg_policy-constrained argument "${refEntry.path}" on "${toolName}".`,
      };
    }

    const { id, mode: explicitMode } = refEntry.parsed;
    const anyRecord = uploadStore.getUploadAnyStatus(agentId, id, sessionId);
    if (!anyRecord) {
      return {
        ok: false,
        error: `Upload "${id}" at "${refEntry.path}" was not found or has expired. Prepare and upload the file first with airlock_prepare_upload.`,
      };
    }
    if (anyRecord.status !== 'ready') {
      return {
        ok: false,
        error: `Upload "${id}" at "${refEntry.path}" has not finished uploading yet (status: ${anyRecord.status}). Upload the file bytes to the upload_url before calling "${toolName}".`,
      };
    }

    if (anyRecord.sizeBytes > maxFileBytes) {
      return {
        ok: false,
        error: `Upload "${id}" (${formatByteSize(anyRecord.sizeBytes)}) exceeds maximum allowed file size (${formatByteSize(maxFileBytes)}).`,
      };
    }

    const mimeErr = validateUploadMimeForAgent(anyRecord.contentType, globalConfig, agentConfig);
    if (mimeErr) {
      return { ok: false, error: mimeErr };
    }

    const nativeKind = input.nativeUploadArgKind?.(refEntry.topKey);

    if (backendKind === 'http' && !nativeKind) {
      return {
        ok: false,
        error: `Built-in HTTP tools only accept staged uploads in "body_upload" or "multipart" (not "${refEntry.path}").`,
      };
    }

    if (nativeKind) {
      if (explicitMode) {
        return {
          ok: false,
          error: `Argument "${refEntry.path}" on "${toolName}" uploads binary data directly; pass the bare reference "airlock-upload://${id}" without ":${explicitMode}".`,
        };
      }
      aggregateNativeBytes += anyRecord.sizeBytes;
      if (aggregateNativeBytes > globalConfig.max_total_bytes) {
        return {
          ok: false,
          error: `Total staged upload payload across arguments (${formatByteSize(aggregateNativeBytes)}) exceeds gateway limit (${formatByteSize(globalConfig.max_total_bytes)}).`,
        };
      }
      plan.nativePointers[refEntry.pointer] = id;
      seenIds.add(id);
      descriptionsById.set(id, describeUploadForHitl(anyRecord));
      auditUploads.push({
        id,
        filename: anyRecord.filename,
        content_type: anyRecord.contentType,
        size_bytes: anyRecord.sizeBytes,
        sha256: anyRecord.sha256,
        mode: nativeKind,
      });
      fingerprintBindings.push({
        pointer: refEntry.pointer,
        id,
        sha256: anyRecord.sha256,
        mode: nativeKind,
      });
      continue;
    }

    // Substitution target (upstream MCP, CLI, or non-native OpenAPI argument)
    const configuredRule = matchToolUploadRule(toolRules, refEntry.segments, refEntry.pointer);
    let chosenMode: UploadDeliveryMode;
    let pathPrefix: string | undefined;

    if (configuredRule) {
      if (explicitMode && explicitMode !== configuredRule.mode) {
        return {
          ok: false,
          error: `Argument "${refEntry.path}" on "${toolName}" is configured for "${configuredRule.mode}" delivery, not ":${explicitMode}". Pass "airlock-upload://${id}".`,
        };
      }
      chosenMode = configuredRule.mode;
      pathPrefix = 'path_prefix' in configuredRule ? configuredRule.path_prefix : undefined;
    } else {
      if (!explicitMode) {
        const modeHint =
          allowedModes.length > 0
            ? `Allowed modes: ${allowedModes.join(', ')} (e.g. "airlock-upload://${id}:${allowedModes[0]}").`
            : 'No unconfigured upload delivery modes are enabled for this agent.';
        return {
          ok: false,
          error: `Upload reference at "${refEntry.path}" on "${toolName}" needs a delivery mode suffix because no tool_overrides upload mapping is configured. ${modeHint}`,
        };
      }
      if (!allowedModes.includes(explicitMode)) {
        return {
          ok: false,
          error: `Upload delivery mode "${explicitMode}" is not allowed for agent "${agentId}" on "${toolName}". Allowed modes: ${allowedModes.join(', ') || 'none'}.`,
        };
      }
      chosenMode = explicitMode;
    }

    if (isInlineDeliveryMode(chosenMode)) {
      if (anyRecord.sizeBytes > maxInlineBytes) {
        return {
          ok: false,
          error: `Upload "${id}" (${formatByteSize(anyRecord.sizeBytes)}) exceeds the inline "${chosenMode}" delivery limit (${formatByteSize(maxInlineBytes)}). Use a multipart/binary endpoint, ":url", or ":path" delivery instead.`,
        };
      }
      const expandedChars = estimatedInlineLength(
        anyRecord.sizeBytes,
        anyRecord.contentType,
        chosenMode
      );
      aggregateInlineChars += expandedChars;
      if (aggregateInlineChars > maxAggregateInlineChars) {
        return {
          ok: false,
          error: `Combined inline upload substitution size across arguments exceeds the per-call materialization limit (${formatByteSize(maxInlineBytes)}).`,
        };
      }
    }

    plan.byPointer[refEntry.pointer] = {
      pointer: refEntry.pointer,
      argPath: refEntry.path,
      uploadId: id,
      mode: chosenMode,
      ...(pathPrefix ? { pathPrefix } : {}),
    };
    seenIds.add(id);
    descriptionsById.set(id, describeUploadForHitl(anyRecord));
    auditUploads.push({
      id,
      filename: anyRecord.filename,
      content_type: anyRecord.contentType,
      size_bytes: anyRecord.sizeBytes,
      sha256: anyRecord.sha256,
      mode: chosenMode,
    });
    fingerprintBindings.push({
      pointer: refEntry.pointer,
      id,
      sha256: anyRecord.sha256,
      mode: chosenMode,
      ...(pathPrefix ? { pathPrefix } : {}),
    });
  }

  return {
    ok: true,
    hasUploads: true,
    plan,
    auditUploads,
    seenIds: Array.from(seenIds),
    hitlArgs: annotateUploadArgs(input.args, (ref) => descriptionsById.get(ref.id)),
    fingerprintBindings,
  };
}

/**
 * Build effective arguments for JSON Schema validation and pre-execution content detectors:
 * - Native binary/multipart handles remain as their validated handle strings.
 * - `:text`, `:base64`, `:data_uri`, and `:path` are resolved to their real effective values
 *   (strictly validating UTF-8 for `:text`).
 * - `:url` uses a synthetic representative URL matching the real minted URL format without
 *   minting a premature short-lived download ticket before human approval.
 */
export async function buildEffectiveArgsForValidation(
  args: Record<string, unknown>,
  agentId: string,
  plan: UploadExecutionPlan,
  uploadStore: UploadStore,
  sessionId?: string
): Promise<
  | { ok: true; effectiveArgs: Record<string, unknown>; detectorText: string }
  | { ok: false; error: string }
> {
  if (Object.keys(plan.byPointer).length === 0) {
    return { ok: true, effectiveArgs: args, detectorText: '' };
  }

  const bytesCache = new Map<string, { bytes: Buffer; contentType: string }>();
  const textCache = new Map<string, string>();
  const detectorParts: string[] = [];
  let syntheticUrlIndex = 0;

  async function loadBytes(uploadId: string): Promise<{ bytes: Buffer; contentType: string }> {
    const cached = bytesCache.get(uploadId);
    if (cached) return cached;
    const { record, bytes } = await uploadStore.readBytes(agentId, uploadId, sessionId);
    const loaded = { bytes, contentType: record.contentType };
    bytesCache.set(uploadId, loaded);
    return loaded;
  }

  try {
    const effectiveArgs = await replaceUploadRefs(
      args,
      async ({ pointer, path, ref }: { pointer: string; path: string; ref: ParsedUploadRef }) => {
        if (plan.nativePointers[pointer] === ref.id && !ref.mode) {
          return ref.raw;
        }
        const planned = plan.byPointer[pointer];
        if (!planned || planned.uploadId !== ref.id) {
          throw new Error(`Upload reference at "${path}" was not validated for delivery.`);
        }
        switch (planned.mode) {
          case 'base64': {
            const { bytes } = await loadBytes(planned.uploadId);
            return bytes.toString('base64');
          }
          case 'data_uri': {
            const { bytes, contentType } = await loadBytes(planned.uploadId);
            return `data:${contentType};base64,${bytes.toString('base64')}`;
          }
          case 'text': {
            let decoded = textCache.get(planned.uploadId);
            if (decoded === undefined) {
              const { bytes } = await loadBytes(planned.uploadId);
              try {
                decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
              } catch {
                throw new Error(
                  `Upload "${planned.uploadId}" is not valid UTF-8 text and cannot be delivered in "text" mode.`
                );
              }
              textCache.set(planned.uploadId, decoded);
              detectorParts.push(decoded);
            }
            return decoded;
          }
          case 'path': {
            const { diskPath } = uploadStore.resolveDiskPath(
              agentId,
              planned.uploadId,
              planned.pathPrefix,
              sessionId
            );
            return diskPath;
          }
          case 'url': {
            syntheticUrlIndex += 1;
            const tokenBuf = Buffer.alloc(32);
            tokenBuf.writeUInt32BE(syntheticUrlIndex, 28);
            const syntheticToken = `dl_${tokenBuf.toString('base64url')}`;
            return `${uploadStore.getInternalBaseUrl()}/uploads/dl/${syntheticToken}`;
          }
        }
      }
    );

    return { ok: true, effectiveArgs, detectorText: detectorParts.join('\n') };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Synchronously confirm right before downstream dispatch that uploads are still enabled and every
 * staged upload referenced by the validated plan is still owned and active.
 */
export function assertUploadPlanActive(
  plan: UploadExecutionPlan,
  agentId: string,
  uploadStore: UploadStore,
  sessionId?: string
): void {
  if (!uploadStore.isEnabled()) {
    throw new Error('File uploads were disabled before dispatch.');
  }
  for (const planned of Object.values(plan.byPointer)) {
    if (!uploadStore.getReadyUpload(agentId, planned.uploadId, sessionId)) {
      throw new Error(`Upload "${planned.uploadId}" is no longer available.`);
    }
  }
  for (const nativeUploadId of Object.values(plan.nativePointers)) {
    if (!uploadStore.getReadyUpload(agentId, nativeUploadId, sessionId)) {
      throw new Error(`Upload "${nativeUploadId}" is no longer available.`);
    }
  }
}

export interface MaterializeUploadArgsOptions {
  /** Compiled JSON Schema validator for final exact dispatch validation (e.g. minted `:url` values). */
  schemaValidator?: ValidateFunction;
}

/**
 * Materialize upload references in tool arguments right before invoking a downstream MCP/CLI/OpenAPI
 * adapter. Always returns a fresh clone so the caller's original `args` (logged to audit & HITL)
 * remain compact. Preserves validated native handles verbatim for multipart/binary body builders.
 * When `options.schemaValidator` is supplied, validates the exact materialized dispatch arguments
 * and revokes any minted download tickets if validation fails.
 */
export async function materializeUploadArgs(
  args: Record<string, unknown>,
  agentId: string,
  plan: UploadExecutionPlan,
  uploadStore: UploadStore,
  sessionId?: string,
  options?: MaterializeUploadArgsOptions
): Promise<Record<string, unknown>> {
  if (Object.keys(plan.byPointer).length === 0) return args;

  const bytesCache = new Map<string, { bytes: Buffer; contentType: string }>();
  const mintedDownloadTokens: string[] = [];

  const revokeMinted = () => {
    for (const token of mintedDownloadTokens) {
      uploadStore.revokeDownloadToken(token);
    }
    mintedDownloadTokens.length = 0;
  };

  async function loadBytes(uploadId: string): Promise<{ bytes: Buffer; contentType: string }> {
    const cached = bytesCache.get(uploadId);
    if (cached) return cached;
    const { record, bytes } = await uploadStore.readBytes(agentId, uploadId, sessionId);
    const loaded = { bytes, contentType: record.contentType };
    bytesCache.set(uploadId, loaded);
    return loaded;
  }

  let materialized: Record<string, unknown>;
  try {
    materialized = await replaceUploadRefs(
      args,
      async ({ pointer, path, ref }: { pointer: string; path: string; ref: ParsedUploadRef }) => {
        if (plan.nativePointers[pointer] === ref.id && !ref.mode) {
          return ref.raw;
        }
        const planned = plan.byPointer[pointer];
        if (!planned || planned.uploadId !== ref.id) {
          throw new Error(`Upload reference at "${path}" was not validated for delivery.`);
        }

        switch (planned.mode) {
          case 'base64': {
            const { bytes } = await loadBytes(planned.uploadId);
            return bytes.toString('base64');
          }
          case 'data_uri': {
            const { bytes, contentType } = await loadBytes(planned.uploadId);
            return `data:${contentType};base64,${bytes.toString('base64')}`;
          }
          case 'text': {
            const { bytes } = await loadBytes(planned.uploadId);
            try {
              return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            } catch {
              throw new Error(
                `Upload "${planned.uploadId}" is not valid UTF-8 text and cannot be delivered in "text" mode.`
              );
            }
          }
          case 'path': {
            const { diskPath } = uploadStore.resolveDiskPath(
              agentId,
              planned.uploadId,
              planned.pathPrefix,
              sessionId
            );
            return diskPath;
          }
          case 'url': {
            const { downloadUrl, downloadToken } = uploadStore.mintDownloadUrl(
              agentId,
              planned.uploadId,
              sessionId
            );
            mintedDownloadTokens.push(downloadToken);
            return downloadUrl;
          }
        }
      }
    );
  } catch (err) {
    revokeMinted();
    throw err;
  }

  if (options?.schemaValidator && !options.schemaValidator(materialized)) {
    revokeMinted();
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Invalid arguments: ${formatSchemaValidationErrors(options.schemaValidator)}`
    );
  }

  // Re-verify every staged upload referenced by this call after async materialization so a
  // concurrent disable or agent revocation cannot slip buffered bytes or tickets past dispatch.
  try {
    assertUploadPlanActive(plan, agentId, uploadStore, sessionId);
  } catch (err) {
    revokeMinted();
    throw err;
  }

  return materialized;
}
