import { createHash, randomBytes } from 'crypto';
import { sha256Hex } from '../security/request.js';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { Document, isMap, parseDocument, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { validateConfig, type ConfigDiagnostic } from '../config/loader.js';
import { applyProfiles } from '../config/profiles.js';
import { GatewayConfig, type GatewayConfig as ParsedGatewayConfig } from '../config/schema.js';

// A change set is the single write path shared by the agent/profile composer and the assistant.
// Both produce the same ops; the operator previews the resulting YAML and applies it explicitly.
// Ops never carry key material: keys are minted at apply time, stored only as a SHA-256 hash, and
// the plaintext is returned exactly once in the apply response.

const Id = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9_.-]+$/,
    'ids may only contain letters, numbers, dots, underscores, and dashes'
  )
  .max(64);
const Patterns = z.array(z.string().trim().min(1).max(200)).max(500);

export const PermissionSpec = z
  .object({
    extends: z.array(Id).max(50).optional(),
    allow: Patterns.optional(),
    ask: Patterns.optional(),
    deny: Patterns.optional(),
  })
  .strict();
export type PermissionSpec = z.infer<typeof PermissionSpec>;

export const AgentSpec = PermissionSpec.extend({
  inherit_default: z.boolean().optional(),
  approval_mode: z.enum(['sync', 'async']).nullable().optional(),
  exec: z
    .object({ allow: Patterns.optional(), ask: Patterns.optional(), deny: Patterns.optional() })
    .strict()
    .optional(),
  http: z.object({ domain_allowlist: Patterns.optional() }).strict().optional(),
}).strict();
export type AgentSpec = z.infer<typeof AgentSpec>;

export const ChangeOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create_agent'), id: Id, agent: AgentSpec.default({}) }).strict(),
  z.object({ op: z.literal('update_agent'), id: Id, agent: AgentSpec }).strict(),
  z.object({ op: z.literal('delete_agent'), id: Id }).strict(),
  z.object({ op: z.literal('rotate_agent_key'), id: Id }).strict(),
  z
    .object({ op: z.literal('create_profile'), id: Id, profile: PermissionSpec.default({}) })
    .strict(),
  z.object({ op: z.literal('update_profile'), id: Id, profile: PermissionSpec }).strict(),
  z.object({ op: z.literal('delete_profile'), id: Id }).strict(),
]);
export type ChangeOp = z.infer<typeof ChangeOp>;

export const ChangeSet = z.object({ ops: z.array(ChangeOp).min(1).max(50) }).strict();

export type EntityKind = 'agent' | 'profile';

export interface EntityChange {
  kind: EntityKind;
  id: string;
  action: 'create' | 'update' | 'delete' | 'rotate';
  before: string | null;
  after: string | null;
}

export interface ChangePreview {
  ok: boolean;
  version: string;
  changes: EntityChange[];
  diagnostics: ConfigDiagnostic[];
  warnings: string[];
}

export interface CreatedKey {
  agentId: string;
  key: string;
}

export interface ChangeApplyResult {
  version: string;
  createdKeys: CreatedKey[];
  changes: EntityChange[];
}

export class ChangeConflictError extends Error {
  constructor() {
    super(
      'The config changed on disk since this preview. Review the change again before applying.'
    );
  }
}

export class ChangeValidationError extends Error {
  constructor(readonly diagnostics: ConfigDiagnostic[]) {
    super(
      diagnostics.map((d) => `${d.agent ? `[${d.agent}] ` : ''}${d.message}`).join('\n') ||
        'Config did not pass validation'
    );
  }
}

const PENDING_HASH = '0'.repeat(64);

export function parseChangeSet(body: unknown): ChangeOp[] {
  const result = ChangeSet.safeParse(body);
  if (!result.success) {
    throw new Error(
      result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')
    );
  }
  return result.data.ops;
}

export function configVersion(raw: string): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

export function createAgentKey(): string {
  return `airlock_agent_${randomBytes(32).toString('base64url')}`;
}

export function hashAgentKey(key: string): string {
  return sha256Hex(key);
}

export function previewChanges(configPath: string, ops: ChangeOp[]): ChangePreview {
  const raw = readRaw(configPath);
  const doc = parseDocument(raw);
  const { changes, warnings } = applyOps(doc, ops, () => PENDING_HASH);
  const diagnostics = validateDocument(doc);
  return {
    ok: !diagnostics.some((d) => d.level === 'error'),
    version: configVersion(raw),
    changes: changes.map(maskPendingHash),
    diagnostics,
    warnings,
  };
}

export function applyChanges(
  configPath: string,
  ops: ChangeOp[],
  expectedVersion?: string
): ChangeApplyResult {
  const raw = readRaw(configPath);
  if (expectedVersion && configVersion(raw) !== expectedVersion) throw new ChangeConflictError();

  const doc = parseDocument(raw);
  const createdKeys: CreatedKey[] = [];
  const { changes } = applyOps(doc, ops, (agentId) => {
    const key = createAgentKey();
    createdKeys.push({ agentId, key });
    return hashAgentKey(key);
  });

  const diagnostics = validateDocument(doc);
  if (diagnostics.some((d) => d.level === 'error')) {
    throw new ChangeValidationError(diagnostics.filter((d) => d.level === 'error'));
  }

  const next = doc.toString();
  copyFileSync(configPath, configPath.replace(/\.ya?ml$/i, '') + '.bak');
  writeFileSync(configPath, next);
  return { version: configVersion(next), createdKeys, changes };
}

function readRaw(configPath: string): string {
  if (!existsSync(configPath)) throw new Error(`Config file not found: ${configPath}`);
  return readFileSync(configPath, 'utf8');
}

function applyOps(
  doc: Document,
  ops: ChangeOp[],
  mintKeyHash: (agentId: string) => string
): { changes: EntityChange[]; warnings: string[] } {
  if (doc.errors.length > 0) throw new Error(`Config is not valid YAML: ${doc.errors[0].message}`);
  if (doc.contents !== null && !isMap(doc.contents))
    throw new Error('Config must be a YAML object');

  const changes: EntityChange[] = [];
  const warnings: string[] = [];

  for (const op of ops) {
    const kind: EntityKind =
      op.op.endsWith('_agent') || op.op === 'rotate_agent_key' ? 'agent' : 'profile';
    const section = kind === 'agent' ? 'agents' : 'profiles';
    const path = [section, op.id];
    const before = snapshot(doc, path);
    const exists = before !== null;

    switch (op.op) {
      case 'create_agent':
      case 'create_profile': {
        if (exists) throw new Error(`${kind} "${op.id}" already exists`);
        const spec = op.op === 'create_agent' ? agentNode(op.agent) : permissionNode(op.profile);
        if (op.op === 'create_agent') spec.token_sha256 = mintKeyHash(op.id);
        ensureSection(doc, section);
        doc.setIn(path, doc.createNode(spec));
        break;
      }
      case 'update_agent':
      case 'update_profile': {
        if (!exists) throw new Error(`${kind} "${op.id}" does not exist`);
        const spec = op.op === 'update_agent' ? agentNode(op.agent) : permissionNode(op.profile);
        for (const [key, value] of Object.entries(spec)) {
          if (value === null) {
            doc.deleteIn([...path, key]);
          } else if (key === 'exec' || key === 'http') {
            for (const [subKey, subValue] of Object.entries(value as Record<string, unknown>)) {
              doc.setIn([...path, key, subKey], doc.createNode(subValue));
            }
          } else {
            doc.setIn([...path, key], doc.createNode(value));
          }
        }
        break;
      }
      case 'delete_agent':
      case 'delete_profile': {
        if (!exists) throw new Error(`${kind} "${op.id}" does not exist`);
        doc.deleteIn(path);
        break;
      }
      case 'rotate_agent_key': {
        if (!exists) throw new Error(`agent "${op.id}" does not exist`);
        doc.deleteIn([...path, 'token']);
        doc.setIn([...path, 'token_sha256'], mintKeyHash(op.id));
        break;
      }
    }

    const after = snapshot(doc, path);
    const action =
      op.op === 'rotate_agent_key' ? 'rotate' : (op.op.split('_')[0] as EntityChange['action']);
    changes.push({ kind, id: op.id, action, before, after });
    warnings.push(...opWarnings(op));
  }

  return { changes, warnings };
}

function agentNode(spec: AgentSpec): Record<string, unknown> {
  const node: Record<string, unknown> = permissionNode(spec);
  if (spec.inherit_default !== undefined) node.inherit_default = spec.inherit_default;
  if (spec.approval_mode !== undefined) node.approval_mode = spec.approval_mode;
  const exec = removeEmpty({ allow: spec.exec?.allow, ask: spec.exec?.ask, deny: spec.exec?.deny });
  if (exec) node.exec = exec;
  const http = removeEmpty({ domain_allowlist: spec.http?.domain_allowlist });
  if (http) node.http = http;
  return node;
}

function permissionNode(spec: PermissionSpec): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  for (const key of ['extends', 'allow', 'ask', 'deny'] as const) {
    if (spec[key] !== undefined) node[key] = Array.from(new Set(spec[key]));
  }
  return node;
}

function removeEmpty(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function ensureSection(doc: Document, section: string): void {
  if (!isMap(doc.get(section))) doc.set(section, doc.createNode({}));
}

function snapshot(doc: Document, path: string[]): string | null {
  const value = doc.getIn(path);
  if (value === undefined) return null;
  const js: unknown = isMap(value) ? value.toJSON() : value;
  return stringifyYaml(redactKeyFields(js)).trimEnd();
}

// Snapshots go to the browser and to the assistant. A legacy plaintext `token` must never leave
// the server, so it is shown as a marker the same way the hash is.
function redactKeyFields(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const copy = { ...(value as Record<string, unknown>) };
  if ('token' in copy) copy.token = '<plaintext key (hidden)>';
  return copy;
}

function maskPendingHash(change: EntityChange): EntityChange {
  return {
    ...change,
    after: change.after?.replace(PENDING_HASH, '<new key hash, minted when you apply>') ?? null,
  };
}

function validateDocument(doc: Document): ConfigDiagnostic[] {
  const js = (doc.toJS() ?? {}) as Record<string, unknown>;
  try {
    const result = GatewayConfig.safeParse(js);
    if (!result.success) {
      return result.error.issues.map((issue) => ({
        level: 'error' as const,
        message: `${issue.path.join('.')}: ${issue.message}`,
      }));
    }
    const config: ParsedGatewayConfig = result.data;
    applyProfiles(config);
    return validateConfig(config);
  } catch (err) {
    return [{ level: 'error', message: err instanceof Error ? err.message : String(err) }];
  }
}

function opWarnings(op: ChangeOp): string[] {
  const warnings: string[] = [];
  const spec =
    op.op === 'create_agent' || op.op === 'update_agent'
      ? op.agent
      : op.op === 'create_profile' || op.op === 'update_profile'
        ? op.profile
        : undefined;
  if (spec?.allow?.some((pattern) => pattern === '*' || pattern === '*/*')) {
    warnings.push(`${op.id}: allows every tool without approval`);
  }
  const broad = spec?.allow?.filter((pattern) => /^[^*]+\/\*$/.test(pattern)) ?? [];
  if (broad.length) {
    warnings.push(`${op.id}: allows whole providers without approval (${broad.join(', ')})`);
  }
  if (op.op === 'create_agent' || op.op === 'update_agent') {
    if (op.agent.exec?.allow?.some((pattern) => pattern === '*')) {
      warnings.push(`${op.id}: allows any shell command without approval`);
    }
  }
  if (op.op === 'delete_agent') warnings.push(`${op.id}: its key stops working immediately`);
  if (op.op === 'rotate_agent_key') warnings.push(`${op.id}: the current key stops working`);
  return warnings;
}
