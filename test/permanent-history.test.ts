import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditDb } from '../src/audit/db.js';
import { AuditLogger } from '../src/audit/logger.js';
import { AuditConfig } from '../src/config/schema.js';

describe('permanent history', () => {
  it('preserves old audit, approval and grant history through migration and repeated cleanup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'airlock-history-'));
    const path = join(dir, 'audit.db');
    const fixture = new Database(path);
    // Pre-upgrade approval table has no metadata column.
    fixture.exec(`
      CREATE TABLE hitl_queue (
        id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, agent_id TEXT NOT NULL,
        tool TEXT NOT NULL, args TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        reason TEXT, created_at TEXT NOT NULL, resolved_at TEXT
      );
      INSERT INTO hitl_queue VALUES (
        'old-approval', 'OLD123', 'review', 'test/read', '{}', 'approved',
        NULL, '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z'
      );
    `);
    fixture.close();
    let db = new AuditDb(path);
    try {
      db.insertAudit({
        ts: '2000-01-01T00:00:00Z', agent_id: 'review',
        tool: 'test/read', args: '{}', result: 'success',
      });
      for (const revoked of [false, true]) {
        db.insertGrant({
          id: revoked ? 'revoked-grant' : 'expired-grant', agent_id: 'review',
          session_id: null, scope: '{"kind":"tool","tool":"test/read"}',
          source: 'operator', approval_id: null, label: null,
          created_at: '2000-01-01T00:00:00Z', expires_at: '2000-01-02T00:00:00Z',
          uses_remaining: 0, revoked_at: revoked ? '2000-01-01T12:00:00Z' : null,
        });
      }
      db.cleanup(0);
      db.close();
      db = new AuditDb(path);
      db.cleanup(0);
      expect(db.queryAudit({})).toHaveLength(1);
      expect(db.getHitlHistory()).toHaveLength(1);
      expect(db.getHitlById('old-approval')?.status).toBe('approved');
      expect(db.getGrantById('expired-grant')).toBeDefined();
      expect(db.getGrantById('revoked-grant')).toBeDefined();
      expect(db.getActiveGrants()).toHaveLength(0);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not schedule deletion when retention is zero', () => {
    vi.useFakeTimers();
    const logger = new AuditLogger(AuditConfig.parse({ db_path: ':memory:', retention_days: 0 }));
    try {
      logger.log({ agent_id: 'review', tool: 'test/read', args: '{}', result: 'success' });
      logger.startDailyCleanup();
      logger.startDailyCleanup();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(365 * 86400_000);
      expect(logger.recent(10)).toHaveLength(1);
    } finally {
      logger.stop();
      vi.useRealTimers();
    }
  });

  it('rejects invalid retention values and defaults to permanent history', () => {
    expect(AuditConfig.parse({}).retention_days).toBe(0);
    for (const retention_days of [-1, 0.5, NaN, Infinity]) {
      expect(AuditConfig.safeParse({ retention_days }).success).toBe(false);
    }
  });
});
