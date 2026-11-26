import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
    db.insertAudit({
      ts: new Date().toISOString(),
      agent_id: 'agent1',
      tool: 'foo',
      args: '{}',
      result: 'success',
    });
    db.insertAudit({
      ts: new Date().toISOString(),
      agent_id: 'agent2',
      tool: 'bar',
      args: '{}',
      result: 'success',
    });

    expect(db.queryAudit({ agent: 'agent1' })).toHaveLength(1);
    expect(db.queryAudit({ agent: 'agent2' })).toHaveLength(1);
  });

  it('filters by tool', () => {
    db.insertAudit({
      ts: new Date().toISOString(),
      agent_id: 'a',
      tool: 'github/create_pr',
      args: '{}',
      result: 'success',
    });
    db.insertAudit({
      ts: new Date().toISOString(),
      agent_id: 'a',
      tool: 'github/list_prs',
      args: '{}',
      result: 'success',
    });

    expect(db.queryAudit({ tool: 'github/create_pr' })).toHaveLength(1);
  });

  it('filters by since', () => {
    db.insertAudit({
      ts: '2025-01-01T00:00:00Z',
      agent_id: 'a',
      tool: 'old',
      args: '{}',
      result: 'success',
    });
    db.insertAudit({
      ts: '2026-01-01T00:00:00Z',
      agent_id: 'a',
      tool: 'new',
      args: '{}',
      result: 'success',
    });

    const rows = db.queryAudit({ since: '2025-06-01T00:00:00Z' });
    expect(rows).toHaveLength(1);
    expect(rows[0].tool).toBe('new');
  });

  it('respects limit', () => {
    for (let i = 0; i < 10; i++) {
      db.insertAudit({
        ts: new Date().toISOString(),
        agent_id: 'a',
        tool: `tool${i}`,
        args: '{}',
        result: 'success',
      });
    }
    expect(db.queryAudit({ limit: 3 })).toHaveLength(3);
  });

  it('inserts and retrieves HITL entries by id', () => {
    db.insertHitl({
      id: 'req-1',
      code: 'ABC123',
      agent_id: 'agent1',
      tool: 'github/create_pr',
      args: '{}',
      status: 'pending',
      created_at: new Date().toISOString(),
    });

    const row = db.getHitlById('req-1');
    expect(row).toBeDefined();
    expect(row?.agent_id).toBe('agent1');
    expect(row?.status).toBe('pending');
  });

  it('updates HITL status', () => {
    db.insertHitl({
      id: 'req-1',
      code: 'ABC123',
      agent_id: 'agent1',
      tool: 'github/create_pr',
      args: '{}',
      status: 'pending',
      created_at: new Date().toISOString(),
    });
    db.updateHitlStatus('req-1', 'approved');

    const row = db.getHitlById('req-1');
    expect(row?.status).toBe('approved');
    expect(row?.resolved_at).toBeDefined();
  });

  it('getPendingHitl returns only pending rows', () => {
    db.insertHitl({
      id: 'r1',
      code: 'AAA111',
      agent_id: 'a',
      tool: 't',
      args: '{}',
      status: 'pending',
      created_at: new Date().toISOString(),
    });
    db.insertHitl({
      id: 'r2',
      code: 'BBB222',
      agent_id: 'a',
      tool: 't',
      args: '{}',
      status: 'approved',
      created_at: new Date().toISOString(),
    });

    const pending = db.getPendingHitl();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe('r1');
  });

  it('getHitlHistory returns resolved HITL rows', () => {
    db.insertHitl({
      id: 'r1',
      code: 'AAA111',
      agent_id: 'a',
      tool: 't',
      args: '{}',
      status: 'pending',
      created_at: new Date().toISOString(),
    });
    db.insertHitl({
      id: 'r2',
      code: 'BBB222',
      agent_id: 'a',
      tool: 't',
      args: '{}',
      status: 'approved',
      created_at: new Date().toISOString(),
    });
    db.updateHitlStatus('r2', 'approved');

    const history = db.getHitlHistory();
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe('r2');
  });

  it('stores and revokes mobile devices', () => {
    const now = new Date().toISOString();
    db.upsertMobileDevice({
      id: 'device-1',
      name: 'Charles iPhone',
      platform: 'ios',
      push_token: 'apns-token',
      auth_token_hash: 'hash-1',
      created_at: now,
      updated_at: now,
    });

    expect(db.getActiveMobileDevices()).toHaveLength(1);
    expect(db.getMobileDeviceByAuthTokenHash('hash-1')?.id).toBe('device-1');

    db.updateMobileDevicePushToken('device-1', 'apns-token-2');
    expect(db.getActiveMobileDevices()[0].push_token).toBe('apns-token-2');

    db.revokeMobileDevice('device-1');
    expect(db.getActiveMobileDevices()).toHaveLength(0);
    expect(db.getMobileDeviceByAuthTokenHash('hash-1')).toBeUndefined();
  });

  it('cleanup removes entries older than retention period', () => {
    db.insertAudit({
      ts: '2020-01-01T00:00:00Z',
      agent_id: 'a',
      tool: 'old',
      args: '{}',
      result: 'success',
    });
    db.insertAudit({
      ts: new Date().toISOString(),
      agent_id: 'a',
      tool: 'new',
      args: '{}',
      result: 'success',
    });

    db.cleanup(30); // 30 days retention — 2020 entry should be gone

    const rows = db.queryAudit({});
    expect(rows.every((r) => r.tool !== 'old')).toBe(true);
    expect(rows.some((r) => r.tool === 'new')).toBe(true);
  });

  it('cleanup(0) retains audit, approval, and grant history permanently', () => {
    db.insertAudit({
      ts: '2000-01-01T00:00:00Z',
      agent_id: 'retention-check',
      tool: 'test/read',
      args: '{}',
      result: 'success',
    });
    db.insertHitl({
      id: 'historical-approval',
      code: 'HIST01',
      agent_id: 'retention-check',
      tool: 'test/read',
      args: '{}',
      status: 'approved',
      created_at: '2000-01-01T00:00:00Z',
    });
    db.insertGrant({
      id: 'historical-grant',
      agent_id: 'retention-check',
      session_id: null,
      scope: '{"kind":"tool","tool":"test/read"}',
      source: 'operator',
      approval_id: null,
      label: null,
      created_at: '2000-01-01T00:00:00Z',
      expires_at: '2000-01-02T00:00:00Z',
      uses_remaining: 0,
      revoked_at: '2000-01-01T12:00:00Z',
    });

    db.cleanup(0);
    expect(db.queryAudit({})).toHaveLength(1);
    expect(db.getHitlById('historical-approval')).toBeDefined();
    expect(db.getGrantById('historical-grant')).toBeDefined();
    expect(() => db.cleanup(-1)).toThrow(RangeError);
    expect(() => db.cleanup(1.5)).toThrow(RangeError);
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
    logger.log({
      agent_id: 'agent1',
      tool: 'github/create_pr',
      args: '{"repo":"test"}',
      result: 'success',
    });
    const rows = logger.recent(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].result).toBe('success');
  });

  it('redacts sensitive fields in args before storing', () => {
    logger.log({
      agent_id: 'agent1',
      tool: 'http/post',
      args: JSON.stringify({
        url: 'https://api.example.com',
        headers: { authorization: 'Bearer secret123' },
      }),
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

  it('redacts configured tool fields in direct calls and approval plans only', () => {
    logger.stop();
    const tool = 'uploads/put_file';
    const other = 'other/update';
    logger = new AuditLogger(makeConfig({ redact_tool_fields: { [tool]: ['content'] } }));
    const upload = { id: 7, filename: 'sample.pdf', content: 'dGVzdA==' };
    const safe = { ...upload, content: '[REDACTED]' };

    expect(logger.redactArgs(upload, tool)).toEqual(safe);
    expect(logger.redactArgs(upload, 'uploads_put_file')).toEqual(safe);
    expect(logger.redactArgs(upload, other)).toEqual(upload);

    logger.log({
      agent_id: 'agent1',
      tool: 'airlock/request_approval',
      args: JSON.stringify({
        calls: [
          { tool: 'uploads_put_file', arguments: upload },
          { tool: 'uploads/put_file', args: upload },
          { tool: other, arguments: upload },
        ],
      }),
      result: 'received',
    });
    expect(JSON.parse(logger.recent(1)[0].args).calls).toEqual([
      { tool: 'uploads_put_file', arguments: safe },
      { tool: 'uploads/put_file', args: safe },
      { tool: other, arguments: upload },
    ]);
    expect(upload.content).toBe('dGVzdA==');
  });

  it('supports sanitized provider_tool config keys, merges overlaps, isolates collisions, and handles aliases', () => {
    logger.stop();
    logger = new AuditLogger(
      makeConfig({
        redact_tool_fields: {
          uploads_put_file: ['content'],
          'uploads/put_file': ['extra'],
          'a/b_c': ['only_a'],
          'a_b/c': ['only_b'],
        },
      })
    );
    logger.setAgentAliases({
      agent1: {
        tool_overrides: {
          safe_upload: { alias_of: 'uploads/put_file' },
        },
      },
    });

    // Sanitized key + canonical key merge without overwriting
    expect(
      logger.redactArgs({ content: 'raw', extra: 'secret', ok: 'yes' }, 'uploads/put_file')
    ).toEqual({
      content: '[REDACTED]',
      extra: '[REDACTED]',
      ok: 'yes',
    });
    // Colliding canonical names do not bleed into each other
    expect(logger.redactArgs({ only_a: '1', only_b: '2' }, 'a/b_c')).toEqual({
      only_a: '[REDACTED]',
      only_b: '2',
    });
    expect(logger.redactArgs({ only_a: '1', only_b: '2' }, 'a_b/c')).toEqual({
      only_a: '1',
      only_b: '[REDACTED]',
    });
    // Alias inherits canonical tool redaction in both log() and approval plans
    logger.log({
      agent_id: 'agent1',
      tool: 'safe_upload',
      args: JSON.stringify({ content: 'raw', extra: 'secret', ok: 'yes' }),
      result: 'received',
    });
    expect(JSON.parse(logger.recent(1)[0].args)).toEqual({
      content: '[REDACTED]',
      extra: '[REDACTED]',
      ok: 'yes',
    });
    // Prototype-key safety
    const protoInput = JSON.parse('{"__proto__":"raw","safe":"ok"}') as Record<string, unknown>;
    logger.updateConfig(makeConfig({ redact_tool_fields: { 'proto/test': ['__proto__'] } }));
    const protoOut = logger.redactArgs(protoInput, 'proto/test');
    expect(Object.getOwnPropertyDescriptor(protoOut, '__proto__')?.value).toBe('[REDACTED]');
    expect(protoOut.safe).toBe('ok');
  });

  it('skips cleanup when retention_days is 0 and supports hot-reloading retention and redaction', () => {
    vi.useFakeTimers();
    try {
      logger.stop();
      logger = new AuditLogger(makeConfig({ retention_days: 0 }));
      logger.startDailyCleanup();
      logger.log({
        agent_id: 'agent1',
        tool: 'uploads/put_file',
        args: JSON.stringify({ content: 'plain' }),
        result: 'success',
      });
      // Advance 200 days — retention_days: 0 keeps the row intact
      vi.advanceTimersByTime(200 * 86400_000);
      expect(logger.recent(10)).toHaveLength(1);

      // Hot-reload enables redact_tool_fields and 30-day retention
      logger.updateConfig(
        makeConfig({
          retention_days: 30,
          redact_tool_fields: { 'uploads/put_file': ['content'] },
        })
      );
      logger.log({
        agent_id: 'agent1',
        tool: 'uploads/put_file',
        args: JSON.stringify({ content: 'plain2' }),
        result: 'success',
      });
      expect(JSON.parse(logger.recent(1)[0].args)).toEqual({ content: '[REDACTED]' });

      // Advance 1 day — daily cleanup timer now fires and removes the 200-day-old row only
      vi.advanceTimersByTime(86400_000);
      expect(logger.recent(10)).toHaveLength(1);
      expect(JSON.parse(logger.recent(1)[0].args)).toEqual({ content: '[REDACTED]' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('query filters work', () => {
    logger.log({ agent_id: 'agent1', tool: 'github/create_pr', args: '{}', result: 'success' });
    logger.log({ agent_id: 'agent2', tool: 'slack/send', args: '{}', result: 'error' });

    expect(logger.query({ agent: 'agent1' })).toHaveLength(1);
    expect(logger.query({ tool: 'slack/send' })).toHaveLength(1);
  });
});
