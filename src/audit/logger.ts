import { AuditDb } from './db.js';
import { redactFields } from './redactor.js';
import type { ApprovalGrantEntry, AuditEntry, HitlQueueEntry, MobileDeviceEntry } from './db.js';
import type { AuditConfig } from '../config/schema.js';
import { AIRLOCK_REQUEST_APPROVAL_TOOL } from '../airlock/tools.js';
import { sanitizeToolName } from '../util/tool-name.js';

type AgentAliasMap = Record<string, { tool_overrides?: Record<string, { alias_of?: string }> }>;

function addFields(map: Map<string, Set<string>>, key: string, fields: string[]): void {
  let set = map.get(key);
  if (!set) {
    set = new Set<string>();
    map.set(key, set);
  }
  for (const field of fields) set.add(field);
}

export class AuditLogger {
  private db: AuditDb;
  private redactPatterns: string[];
  private exactToolFields = new Map<string, Set<string>>();
  private sanitizedConfiguredToolFields = new Map<string, Set<string>>();
  private allSanitizedToolFields = new Map<string, Set<string>>();
  private agentAliases = new Map<string, Map<string, string>>();
  private retentionDays: number;
  private cleanupTimer?: NodeJS.Timeout;
  private cleanupStarted = false;

  constructor(config: AuditConfig) {
    this.db = new AuditDb(config.db_path);
    this.redactPatterns = config.redact_fields;
    this.loadToolFields(config.redact_tool_fields);
    this.retentionDays = config.retention_days;
  }

  private loadToolFields(redactToolFields?: Record<string, string[]>): void {
    this.exactToolFields.clear();
    this.sanitizedConfiguredToolFields.clear();
    this.allSanitizedToolFields.clear();
    for (const [tool, fields] of Object.entries(redactToolFields ?? {})) {
      addFields(this.exactToolFields, tool, fields);
      addFields(this.allSanitizedToolFields, sanitizeToolName(tool), fields);
      if (!tool.includes('/')) {
        addFields(this.sanitizedConfiguredToolFields, tool, fields);
      }
    }
  }

  /** Update redaction and retention settings live on config hot-reload. */
  updateConfig(config: AuditConfig): void {
    this.redactPatterns = config.redact_fields;
    this.loadToolFields(config.redact_tool_fields);
    this.retentionDays = config.retention_days;
    if (this.retentionDays === 0 && this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    } else if (this.cleanupStarted && this.retentionDays > 0 && !this.cleanupTimer) {
      this.armCleanupTimer();
    }
  }

  /** Register per-agent tool_overrides alias mappings so aliases inherit canonical redaction. */
  setAgentAliases(agents: AgentAliasMap): void {
    this.agentAliases.clear();
    for (const [agentId, agent] of Object.entries(agents)) {
      const aliases = new Map<string, string>();
      for (const [alias, override] of Object.entries(agent.tool_overrides ?? {})) {
        if (!override.alias_of) continue;
        aliases.set(alias, override.alias_of);
        aliases.set(sanitizeToolName(alias), override.alias_of);
      }
      if (aliases.size > 0) this.agentAliases.set(agentId, aliases);
    }
  }

  private resolveAlias(agentId: string | undefined, tool: string): string | undefined {
    if (!agentId) return undefined;
    const aliases = this.agentAliases.get(agentId);
    if (!aliases) return undefined;
    return aliases.get(tool) ?? aliases.get(sanitizeToolName(tool));
  }

  log(entry: Omit<AuditEntry, 'id' | 'ts'>): void {
    let args = entry.args;
    try {
      const parsed = JSON.parse(args) as Record<string, unknown>;
      const redacted = this.redactArgs(parsed, entry.tool, entry.agent_id);
      args = JSON.stringify(redacted);
    } catch {
      // not valid JSON, store as-is
    }
    this.db.insertAudit({ ...entry, args, ts: new Date().toISOString() });
  }

  redactArgs(
    args: Record<string, unknown>,
    tool?: string | string[],
    agentId?: string
  ): Record<string, unknown> {
    const redacted = redactFields(args, this.redactPatterns) as Record<string, unknown>;
    if (!tool || !redacted || typeof redacted !== 'object') return redacted;
    const tools = Array.isArray(tool) ? tool : [tool];
    for (const candidate of tools) {
      this.redactToolFields(candidate, redacted, agentId);
    }
    if (
      tools.some(
        (candidate) =>
          candidate === AIRLOCK_REQUEST_APPROVAL_TOOL ||
          candidate === sanitizeToolName(AIRLOCK_REQUEST_APPROVAL_TOOL)
      ) &&
      Array.isArray(redacted.calls)
    ) {
      for (const call of redacted.calls as unknown[]) {
        if (!call || typeof call !== 'object' || !('tool' in call)) continue;
        const {
          tool: callTool,
          arguments: inputs,
          args: callArgs,
        } = call as Record<string, unknown>;
        if (typeof callTool !== 'string') continue;
        this.redactToolFields(callTool, inputs, agentId);
        this.redactToolFields(callTool, callArgs, agentId);
      }
    }
    return redacted;
  }

  private fieldsForTool(tool: string): Set<string> | undefined {
    const exact = this.exactToolFields.get(tool);
    const secondary = tool.includes('/')
      ? this.sanitizedConfiguredToolFields.get(sanitizeToolName(tool))
      : this.allSanitizedToolFields.get(tool);
    if (!exact) return secondary;
    if (!secondary) return exact;
    const merged = new Set<string>(exact);
    for (const field of secondary) merged.add(field);
    return merged;
  }

  private redactToolFields(tool: string, args: unknown, agentId?: string): void {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return;
    const canonical = this.resolveAlias(agentId, tool);
    const names = canonical && canonical !== tool ? [tool, canonical] : [tool];
    for (const name of names) {
      for (const field of this.fieldsForTool(name) ?? []) {
        if (Object.hasOwn(args, field)) {
          Object.defineProperty(args, field, {
            value: '[REDACTED]',
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
      }
    }
  }

  recent(n: number): AuditEntry[] {
    return this.db.queryAudit({ limit: n });
  }

  query(filters: { agent?: string; tool?: string; since?: string; limit?: number }): AuditEntry[] {
    return this.db.queryAudit(filters);
  }

  // HITL queue delegation
  insertHitl(entry: HitlQueueEntry): void {
    this.db.insertHitl(entry);
  }
  updateHitlStatus(id: string, status: HitlQueueEntry['status'], reason?: string): void {
    this.db.updateHitlStatus(id, status, reason);
  }
  getHitlById(id: string): HitlQueueEntry | undefined {
    return this.db.getHitlById(id);
  }
  getPendingHitl(): HitlQueueEntry[] {
    return this.db.getPendingHitl();
  }
  getHitlHistory(limit?: number): HitlQueueEntry[] {
    return this.db.getHitlHistory(limit);
  }
  insertGrant(entry: ApprovalGrantEntry): void {
    this.db.insertGrant(entry);
  }
  updateGrantUses(id: string, usesRemaining: number): void {
    this.db.updateGrantUses(id, usesRemaining);
  }
  consumeGrantUse(id: string): boolean {
    return this.db.consumeGrantUse(id);
  }
  getGrantById(id: string): ApprovalGrantEntry | undefined {
    return this.db.getGrantById(id);
  }
  revokeGrant(id: string): void {
    this.db.revokeGrant(id);
  }
  getActiveGrants(): ApprovalGrantEntry[] {
    return this.db.getActiveGrants();
  }
  upsertMobileDevice(entry: Omit<MobileDeviceEntry, 'revoked_at'>): void {
    this.db.upsertMobileDevice(entry);
  }
  updateMobileDevicePushToken(id: string, pushToken: string): void {
    this.db.updateMobileDevicePushToken(id, pushToken);
  }
  getMobileDeviceByAuthTokenHash(authTokenHash: string): MobileDeviceEntry | undefined {
    return this.db.getMobileDeviceByAuthTokenHash(authTokenHash);
  }
  getActiveMobileDevices(): MobileDeviceEntry[] {
    return this.db.getActiveMobileDevices();
  }
  revokeMobileDevice(id: string): void {
    this.db.revokeMobileDevice(id);
  }

  startDailyCleanup(): void {
    this.cleanupStarted = true;
    if (this.retentionDays === 0 || this.cleanupTimer) return;
    this.armCleanupTimer();
  }

  private armCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.db.cleanup(this.retentionDays);
    }, 86400_000);
    this.cleanupTimer.unref();
  }

  stop(): void {
    this.cleanupStarted = false;
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
    this.db.close();
  }
}
