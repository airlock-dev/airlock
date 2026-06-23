import { AuditDb } from './db.js';
import { redactFields } from './redactor.js';
import type { AuditEntry, HitlQueueEntry, MobileDeviceEntry } from './db.js';
import type { AuditConfig } from '../config/schema.js';

export class AuditLogger {
  private db: AuditDb;
  private redactPatterns: string[];
  private retentionDays: number;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(config: AuditConfig) {
    this.db = new AuditDb(config.db_path);
    this.redactPatterns = config.redact_fields;
    this.retentionDays = config.retention_days;
  }

  log(entry: Omit<AuditEntry, 'id' | 'ts'>): void {
    let args = entry.args;
    try {
      const parsed = JSON.parse(args) as Record<string, unknown>;
      const redacted = redactFields(parsed, this.redactPatterns);
      args = JSON.stringify(redacted);
    } catch {
      // not valid JSON, store as-is
    }
    this.db.insertAudit({ ...entry, args, ts: new Date().toISOString() });
  }

  redactArgs(args: Record<string, unknown>): Record<string, unknown> {
    return redactFields(args, this.redactPatterns) as Record<string, unknown>;
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
  getHitlByCode(code: string): HitlQueueEntry | undefined {
    return this.db.getHitlByCode(code);
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
