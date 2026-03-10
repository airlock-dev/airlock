import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AuditDb } from '../src/audit/db.js';
import { AuditLogger } from '../src/audit/logger.js';
import { redactFields } from '../src/audit/redactor.js';
import type { AuditConfig } from '../src/config/schema.js';

// ─── redactFields ─────────────────────────────────────────────────────────────

describe('redactFields()', () => {
  it('redacts exact field name match (case-insensitive)', () => {
    const result = redactFields({ password: 'secret123' }, ['password']);
    expect(result).toEqual({ password: '[REDACTED]' });
  });

  it('redacts substring match in field name', () => {
    const result = redactFields({ api_token: 'abc123', access_key: 'xyz' }, ['token', 'key']);
    expect(result).toEqual({ api_token: '[REDACTED]', access_key: '[REDACTED]' });
  });

  it('redacts nested fields recursively', () => {
    const result = redactFields({ user: { password: 'secret', name: 'alice' } }, ['password']);
    expect(result).toEqual({ user: { password: '[REDACTED]', name: 'alice' } });
  });

  it('redacts inside arrays', () => {
    const result = redactFields([{ token: 'abc' }, { token: 'def' }], ['token']);
    expect(result).toEqual([{ token: '[REDACTED]' }, { token: '[REDACTED]' }]);
  });

  it('leaves non-matching fields untouched', () => {
    const result = redactFields({ repo: 'myrepo', title: 'My PR' }, ['password']);
    expect(result).toEqual({ repo: 'myrepo', title: 'My PR' });
  });

  it('handles null and undefined gracefully', () => {
    expect(redactFields(null, ['password'])).toBeNull();
    expect(redactFields(undefined, ['password'])).toBeUndefined();
  });

  it('handles primitives gracefully', () => {
    expect(redactFields('hello', ['password'])).toBe('hello');
    expect(redactFields(42, ['password'])).toBe(42);
  });
});

// ─── AuditDb ──────────────────────────────────────────────────────────────────

describe('AuditDb', () => {
  let db: AuditDb;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'airlock-test-'));
    db = new AuditDb(join(dir, 'audit.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true });
  });

  it('inserts and queries audit entries', () => {
    db.insertAudit({
      ts: '2026-01-01T00:00:00Z',
      agent_id: 'agent1',
      tool: 'github/create_pr',
      args: '{"repo":"test"}',
      result: 'success',
      duration_ms: 42,
    });

    const rows = db.queryAudit({});
    expect(rows).toHaveLength(1);
    expect(rows[0].tool).toBe('github/create_pr');
    expect(rows[0].result).toBe('success');
  });

  it('filters by agent_id', () => {
    db.insertAudit({ ts: new Date().toISOString(), agent_id: 'agent1', tool: 'foo', args: '{}', result: 'success' });
    db.insertAudit({ ts: new Date().toISOString(), agent_id: 'agent2', tool: 'bar', args: '{}', result: 'success' });

    expect(db.queryAudit({ agent: 'agent1' })).toHaveLength(1);
    expect(db.queryAudit({ agent: 'agent2' })).toHaveLength(1);
  });

  it('filters by tool', () => {
    db.insertAudit({ ts: new Date().toISOString(), agent_id: 'a', tool: 'github/create_pr', args: '{}', result: 'success' });
    db.insertAudit({ ts: new Date().toISOString(), agent_id: 'a', tool: 'github/list_prs',  args: '{}', result: 'success' });

    expect(db.queryAudit({ tool: 'github/create_pr' })).toHaveLength(1);
  });

  it('filters by since', () => {
    db.insertAudit({ ts: '2025-01-01T00:00:00Z', agent_id: 'a', tool: 'old', args: '{}', result: 'success' });
    db.insertAudit({ ts: '2026-01-01T00:00:00Z', agent_id: 'a', tool: 'new', args: '{}', result: 'success' });

    const rows = db.queryAudit({ since: '2025-06-01T00:00:00Z' });
    expect(rows).toHaveLength(1);
    expect(rows[0].tool).toBe('new');
  });

  it('respects limit', () => {
    for (let i = 0; i < 10; i++) {
      db.insertAudit({ ts: new Date().toISOString(), agent_id: 'a', tool: `tool${i}`, args: '{}', result: 'success' });
    }
    expect(db.queryAudit({ limit: 3 })).toHaveLength(3);
  });

  it('inserts and retrieves HITL entries by code', () => {
    db.insertHitl({
      id: 'req-1', code: 'ABC123', agent_id: 'agent1',
      tool: 'github/create_pr', args: '{}', status: 'pending',
      created_at: new Date().toISOString(),
    });

    const row = db.getHitlByCode('ABC123');
    expect(row).toBeDefined();
    expect(row?.agent_id).toBe('agent1');
    expect(row?.status).toBe('pending');
  });

  it('updates HITL status', () => {
    db.insertHitl({
      id: 'req-1', code: 'ABC123', agent_id: 'agent1',
      tool: 'github/create_pr', args: '{}', status: 'pending',
      created_at: new Date().toISOString(),
    });
    db.updateHitlStatus('req-1', 'approved');

    const row = db.getHitlById('req-1');
    expect(row?.status).toBe('approved');
    expect(row?.resolved_at).toBeDefined();
  });

  it('getPendingHitl returns only pending rows', () => {
    db.insertHitl({ id: 'r1', code: 'AAA111', agent_id: 'a', tool: 't', args: '{}', status: 'pending', created_at: new Date().toISOString() });
    db.insertHitl({ id: 'r2', code: 'BBB222', agent_id: 'a', tool: 't', args: '{}', status: 'approved', created_at: new Date().toISOString() });

    const pending = db.getPendingHitl();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe('r1');
  });

  it('cleanup removes entries older than retention period', () => {
    db.insertAudit({ ts: '2020-01-01T00:00:00Z', agent_id: 'a', tool: 'old', args: '{}', result: 'success' });
    db.insertAudit({ ts: new Date().toISOString(), agent_id: 'a', tool: 'new', args: '{}', result: 'success' });

    db.cleanup(30); // 30 days retention — 2020 entry should be gone

    const rows = db.queryAudit({});
    expect(rows.every(r => r.tool !== 'old')).toBe(true);
    expect(rows.some(r => r.tool === 'new')).toBe(true);
  });
});

// ─── AuditLogger ──────────────────────────────────────────────────────────────

describe('AuditLogger', () => {
  let logger: AuditLogger;
  let dir: string;

  function makeConfig(overrides: Partial<AuditConfig> = {}): AuditConfig {
    return {
      db_path: join(dir, 'audit.db'),
      retention_days: 90,
      redact_fields: ['password', 'token', 'secret', 'key', 'authorization'],
      ...overrides,
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'airlock-test-'));
    logger = new AuditLogger(makeConfig());
  });

  afterEach(() => {
    logger.stop();
    rmSync(dir, { recursive: true });
  });

  it('stores log entries and retrieves them', () => {
    logger.log({ agent_id: 'agent1', tool: 'github/create_pr', args: '{"repo":"test"}', result: 'success' });
    const rows = logger.recent(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].result).toBe('success');
  });

  it('redacts sensitive fields in args before storing', () => {
    logger.log({
      agent_id: 'agent1',
      tool: 'http/post',
      args: JSON.stringify({ url: 'https://api.example.com', headers: { authorization: 'Bearer secret123' } }),
      result: 'success',
    });

    const rows = logger.recent(1);
    const stored = JSON.parse(rows[0].args);
    expect(stored.headers.authorization).toBe('[REDACTED]');
    expect(stored.url).toBe('https://api.example.com');
  });

  it('stores args as-is when not valid JSON', () => {
    logger.log({ agent_id: 'a', tool: 't', args: 'not-json', result: 'success' });
    const rows = logger.recent(1);
    expect(rows[0].args).toBe('not-json');
  });

  it('query filters work', () => {
    logger.log({ agent_id: 'agent1', tool: 'github/create_pr', args: '{}', result: 'success' });
    logger.log({ agent_id: 'agent2', tool: 'slack/send',        args: '{}', result: 'error'   });

    expect(logger.query({ agent: 'agent1' })).toHaveLength(1);
    expect(logger.query({ tool: 'slack/send' })).toHaveLength(1);
  });
});
