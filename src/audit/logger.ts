import { AuditDb } from './db.js';
import { redactFields } from './redactor.js';
import type { ApprovalGrantEntry, AuditEntry, HitlQueueEntry, MobileDeviceEntry } from './db.js';
import type { AuditConfig } from '../config/schema.js';
import { AIRLOCK_REQUEST_APPROVAL_TOOL } from '../airlock/tools.js';
import { sanitizeToolName } from '../util/tool-name.js';

export class AuditLogger {
  private db: AuditDb;
  private redactPatterns: string[];
  private toolFields = new Map<string, string[]>();
  private retentionDays: number;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(config: AuditConfig) {
    this.db = new AuditDb(config.db_path);
    this.redactPatterns = config.redact_fields;
    for (const [tool, fields] of Object.entries(config.redact_tool_fields ?? {})) {
      this.toolFields.set(tool, fields);
      this.toolFields.set(sanitizeToolName(tool), fields);
    }
    this.retentionDays = config.retention_days;
  }

  log(entry: Omit<AuditEntry, 'id' | 'ts'>): void {
    let args = entry.args;
    try {
      const parsed = JSON.parse(args) as Record<string, unknown>;
      const redacted = this.redactArgs(parsed, entry.tool);
      args = JSON.stringify(redacted);
    } catch {
      // not valid JSON, store as-is
    }
    this.db.insertAudit({ ...entry, args, ts: new Date().toISOString() });
  }

  redactArgs(args: Record<string, unknown>, tool?: string): Record<string, unknown> {
    const redacted = redactFields(args, this.redactPatterns) as Record<string, unknown>;
    if (!tool || !redacted || typeof redacted !== 'object') return redacted;
    this.redactToolFields(tool, redacted);
    if (
      (tool === AIRLOCK_REQUEST_APPROVAL_TOOL ||
        tool === sanitizeToolName(AIRLOCK_REQUEST_APPROVAL_TOOL)) &&
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
        this.redactToolFields(callTool, inputs);
        this.redactToolFields(callTool, callArgs);
      }
    }
    return redacted;
  }

  private redactToolFields(tool: string, args: unknown): void {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return;
    for (const field of this.toolFields.get(tool) ?? []) {
      if (Object.hasOwn(args, field)) (args as Record<string, unknown>)[field] = '[REDACTED]';
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
    if (this.retentionDays === 0 || this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      this.db.cleanup(this.retentionDays);
    }, 86400_000);
    this.cleanupTimer.unref();
  }

  stop(): void {
    clearInterval(this.cleanupTimer);
    this.db.close();
  }
}
