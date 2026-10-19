import Database from 'better-sqlite3';

export interface AuditEntry {
  id?: number;
  ts: string; // ISO timestamp
  agent_id: string;
  tool: string;
  args: string; // JSON string
  // Lifecycle + terminal states. A single call emits several rows sharing request_id:
  //   'received'   — request entered the pipeline
  //   'dispatched' — passed policy, handed to the downstream (last checkpoint before a hang)
  //   terminal     — 'success' | 'error' | 'denied' | 'arg_policy_denied' |
  //                  'hitl_approved' | 'hitl_denied' | 'hitl_timeout' | 'hitl_disconnected'
  // A request_id with 'received'/'dispatched' but no terminal row is a call still in flight (or hung).
  result: string;
  error?: string;
  duration_ms?: number;
  hitl_code?: string;
  /** Correlates every lifecycle row of one tool call (the ctx.callId). */
  request_id?: string;
}

export interface HitlQueueEntry {
  id: string;
  code: string;
  agent_id: string;
  tool: string;
  args: string; // JSON string
  status: 'pending' | 'approved' | 'denied' | 'timeout' | 'cancelled';
  reason?: string;
  created_at: string;
  resolved_at?: string;
  /** JSON-encoded approval metadata (fingerprint, mode, plan, batch, …) for restart recovery. */
  meta?: string | null;
}

export interface ApprovalGrantEntry {
  id: string;
  agent_id: string;
  session_id: string | null;
  scope: string; // JSON-encoded GrantScope
  source: string;
  approval_id: string | null;
  label: string | null;
  created_at: string;
  expires_at: string | null;
  uses_remaining: number | null;
  revoked_at: string | null;
}

export interface MobileDeviceEntry {
  id: string;
  name: string;
  platform: 'ios';
  push_token: string;
  auth_token_hash: string;
  created_at: string;
  updated_at: string;
  revoked_at?: string;
}

export class AuditDb {
  private db: Database.Database;
  private stmts!: {
    insertAudit: Database.Statement;
    insertHitl: Database.Statement;
    updateHitlStatus: Database.Statement;
    getHitlByCode: Database.Statement;
    getHitlById: Database.Statement;
    getPendingHitl: Database.Statement;
    getHitlHistory: Database.Statement;
    insertMobileDevice: Database.Statement;
    updateMobileDevicePushToken: Database.Statement;
    getMobileDeviceByAuthTokenHash: Database.Statement;
    getActiveMobileDevices: Database.Statement;
    revokeMobileDevice: Database.Statement;
    cleanupAudit: Database.Statement;
    cleanupHitl: Database.Statement;
    insertGrant: Database.Statement;
    updateGrantUses: Database.Statement;
    consumeGrantUse: Database.Statement;
    getGrantById: Database.Statement;
    revokeGrant: Database.Statement;
    getActiveGrants: Database.Statement;
    cleanupGrants: Database.Statement;
  };

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.init();
    this.prepareStatements();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ts          TEXT    NOT NULL,
        agent_id    TEXT    NOT NULL,
        tool        TEXT    NOT NULL,
        args        TEXT    NOT NULL,
        result      TEXT    NOT NULL,
        error       TEXT,
        duration_ms INTEGER,
        hitl_code   TEXT,
        request_id  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_ts       ON audit_log(ts);
      CREATE INDEX IF NOT EXISTS idx_audit_agent_id ON audit_log(agent_id);
      CREATE INDEX IF NOT EXISTS idx_audit_tool     ON audit_log(tool);

      CREATE TABLE IF NOT EXISTS hitl_queue (
        id          TEXT    PRIMARY KEY,
        code        TEXT    NOT NULL UNIQUE,
        agent_id    TEXT    NOT NULL,
        tool        TEXT    NOT NULL,
        args        TEXT    NOT NULL,
        status      TEXT    NOT NULL DEFAULT 'pending',
        reason      TEXT,
        created_at  TEXT    NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_hitl_status ON hitl_queue(status);
      CREATE INDEX IF NOT EXISTS idx_hitl_code   ON hitl_queue(code);

      CREATE TABLE IF NOT EXISTS mobile_devices (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        platform        TEXT NOT NULL,
        push_token      TEXT NOT NULL,
        auth_token_hash TEXT NOT NULL UNIQUE,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        revoked_at      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_mobile_devices_revoked ON mobile_devices(revoked_at);

      CREATE TABLE IF NOT EXISTS approval_grants (
        id             TEXT PRIMARY KEY,
        agent_id       TEXT NOT NULL,
        session_id     TEXT,
        scope          TEXT NOT NULL,
        source         TEXT NOT NULL,
        approval_id    TEXT,
        label          TEXT,
        created_at     TEXT NOT NULL,
        expires_at     TEXT,
        uses_remaining INTEGER,
        revoked_at     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_grants_agent ON approval_grants(agent_id);
    `);

    this.migrate();
  }

  /**
   * Idempotent, additive schema migrations for DBs created by older versions. Runs after the
   * CREATE TABLE IF NOT EXISTS block, which never adds columns to a table that already exists.
   */
  private migrate(): void {
    const auditCols = new Set(
      (this.db.pragma('table_info(audit_log)') as Array<{ name: string }>).map((c) => c.name)
    );
    if (!auditCols.has('request_id')) {
      // Correlates the lifecycle rows (received/dispatched/terminal) of one tool call.
      this.db.exec('ALTER TABLE audit_log ADD COLUMN request_id TEXT');
    }
    // Safe on both fresh and migrated DBs now that the column is guaranteed to exist.
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_audit_request_id ON audit_log(request_id)');

    const hitlCols = new Set(
      (this.db.pragma('table_info(hitl_queue)') as Array<{ name: string }>).map((c) => c.name)
    );
    if (!hitlCols.has('meta')) {
      this.db.exec('ALTER TABLE hitl_queue ADD COLUMN meta TEXT');
    }
  }

  private prepareStatements(): void {
    this.stmts = {
      insertAudit: this.db.prepare(`
        INSERT INTO audit_log (ts, agent_id, tool, args, result, error, duration_ms, hitl_code, request_id)
        VALUES (@ts, @agent_id, @tool, @args, @result, @error, @duration_ms, @hitl_code, @request_id)
      `),
      insertHitl: this.db.prepare(`
        INSERT INTO hitl_queue (id, code, agent_id, tool, args, status, created_at, meta)
        VALUES (@id, @code, @agent_id, @tool, @args, @status, @created_at, @meta)
      `),
      updateHitlStatus: this.db.prepare(`
        UPDATE hitl_queue SET status = @status, reason = @reason, resolved_at = @resolved_at WHERE id = @id
      `),
      getHitlByCode: this.db.prepare('SELECT * FROM hitl_queue WHERE code = ?'),
      getHitlById: this.db.prepare('SELECT * FROM hitl_queue WHERE id = ?'),
      getPendingHitl: this.db.prepare(
        "SELECT * FROM hitl_queue WHERE status = 'pending' ORDER BY created_at ASC"
      ),
      getHitlHistory: this.db.prepare(`
        SELECT * FROM hitl_queue
        WHERE status != 'pending'
        ORDER BY COALESCE(resolved_at, created_at) DESC
        LIMIT ?
      `),
      insertMobileDevice: this.db.prepare(`
        INSERT INTO mobile_devices (
          id, name, platform, push_token, auth_token_hash, created_at, updated_at, revoked_at
        )
        VALUES (
          @id, @name, @platform, @push_token, @auth_token_hash, @created_at, @updated_at, NULL
        )
        ON CONFLICT(auth_token_hash) DO UPDATE SET
          name = excluded.name,
          push_token = excluded.push_token,
          updated_at = excluded.updated_at,
          revoked_at = NULL
      `),
      updateMobileDevicePushToken: this.db.prepare(`
        UPDATE mobile_devices
        SET push_token = @push_token, updated_at = @updated_at
        WHERE id = @id AND revoked_at IS NULL
      `),
      getMobileDeviceByAuthTokenHash: this.db.prepare(`
        SELECT * FROM mobile_devices
        WHERE auth_token_hash = ? AND revoked_at IS NULL
      `),
      getActiveMobileDevices: this.db.prepare(`
        SELECT * FROM mobile_devices
        WHERE revoked_at IS NULL
        ORDER BY created_at ASC
      `),
      revokeMobileDevice: this.db.prepare(`
        UPDATE mobile_devices
        SET revoked_at = @revoked_at, updated_at = @revoked_at
        WHERE id = @id AND revoked_at IS NULL
      `),
      cleanupAudit: this.db.prepare('DELETE FROM audit_log WHERE ts < ?'),
      cleanupHitl: this.db.prepare(
        "DELETE FROM hitl_queue WHERE status != 'pending' AND resolved_at < ?"
      ),
      insertGrant: this.db.prepare(`
        INSERT INTO approval_grants (
          id, agent_id, session_id, scope, source, approval_id, label,
          created_at, expires_at, uses_remaining, revoked_at
        )
        VALUES (
          @id, @agent_id, @session_id, @scope, @source, @approval_id, @label,
          @created_at, @expires_at, @uses_remaining, @revoked_at
        )
      `),
      updateGrantUses: this.db.prepare(
        'UPDATE approval_grants SET uses_remaining = @uses_remaining WHERE id = @id'
      ),
      // Atomic across processes sharing this DB (stdio mode runs one process per session).
      consumeGrantUse: this.db.prepare(`
        UPDATE approval_grants SET uses_remaining = uses_remaining - 1
        WHERE id = ? AND revoked_at IS NULL AND uses_remaining > 0
      `),
      getGrantById: this.db.prepare('SELECT * FROM approval_grants WHERE id = ?'),
      revokeGrant: this.db.prepare(
        'UPDATE approval_grants SET revoked_at = @revoked_at WHERE id = @id AND revoked_at IS NULL'
      ),
      getActiveGrants: this.db.prepare(`
        SELECT * FROM approval_grants
        WHERE revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
          AND (uses_remaining IS NULL OR uses_remaining > 0)
        ORDER BY created_at ASC
      `),
      cleanupGrants: this.db.prepare(
        'DELETE FROM approval_grants WHERE COALESCE(revoked_at, expires_at, created_at) < ?'
      ),
    };
  }

  insertAudit(entry: Omit<AuditEntry, 'id'>): void {
    this.stmts.insertAudit.run({
      error: null,
      duration_ms: null,
      hitl_code: null,
      request_id: null,
      ...entry,
    });
  }

  queryAudit(filters: {
    agent?: string;
    tool?: string;
    since?: string;
    limit?: number;
  }): AuditEntry[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (filters.agent) {
      conditions.push('agent_id = @agent');
      params.agent = filters.agent;
    }
    if (filters.tool) {
      conditions.push('tool = @tool');
      params.tool = filters.tool;
    }
    if (filters.since) {
      conditions.push('ts >= @since');
      params.since = filters.since;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(filters.limit ?? 100, 10000));
    params.limit = limit;

    return this.db
      .prepare(`SELECT * FROM audit_log ${where} ORDER BY ts DESC LIMIT @limit`)
      .all(params) as AuditEntry[];
  }

  insertHitl(entry: HitlQueueEntry): void {
    this.stmts.insertHitl.run({ ...entry, meta: entry.meta ?? null });
  }

  insertGrant(entry: ApprovalGrantEntry): void {
    this.stmts.insertGrant.run(entry);
  }

  updateGrantUses(id: string, usesRemaining: number): void {
    this.stmts.updateGrantUses.run({ id, uses_remaining: usesRemaining });
  }

  /** Spend one use of a limited grant. False when it is used up or revoked (maybe elsewhere). */
  consumeGrantUse(id: string): boolean {
    return this.stmts.consumeGrantUse.run(id).changes > 0;
  }

  getGrantById(id: string): ApprovalGrantEntry | undefined {
    return this.stmts.getGrantById.get(id) as ApprovalGrantEntry | undefined;
  }

  revokeGrant(id: string): void {
    this.stmts.revokeGrant.run({ id, revoked_at: new Date().toISOString() });
  }

  getActiveGrants(): ApprovalGrantEntry[] {
    return this.stmts.getActiveGrants.all(new Date().toISOString()) as ApprovalGrantEntry[];
  }

  updateHitlStatus(id: string, status: HitlQueueEntry['status'], reason?: string): void {
    this.stmts.updateHitlStatus.run({
      id,
      status,
      reason: reason ?? null,
      resolved_at: new Date().toISOString(),
    });
  }

  getHitlByCode(code: string): HitlQueueEntry | undefined {
    return this.stmts.getHitlByCode.get(code) as HitlQueueEntry | undefined;
  }

  getHitlById(id: string): HitlQueueEntry | undefined {
    return this.stmts.getHitlById.get(id) as HitlQueueEntry | undefined;
  }

  getPendingHitl(): HitlQueueEntry[] {
    return this.stmts.getPendingHitl.all() as HitlQueueEntry[];
  }

  getHitlHistory(limit = 50): HitlQueueEntry[] {
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    return this.stmts.getHitlHistory.all(boundedLimit) as HitlQueueEntry[];
  }

  upsertMobileDevice(entry: Omit<MobileDeviceEntry, 'revoked_at'>): void {
    this.stmts.insertMobileDevice.run(entry);
  }

  updateMobileDevicePushToken(id: string, pushToken: string): void {
    this.stmts.updateMobileDevicePushToken.run({
      id,
      push_token: pushToken,
      updated_at: new Date().toISOString(),
    });
  }

  getMobileDeviceByAuthTokenHash(authTokenHash: string): MobileDeviceEntry | undefined {
    return this.stmts.getMobileDeviceByAuthTokenHash.get(authTokenHash) as
      | MobileDeviceEntry
      | undefined;
  }

  getActiveMobileDevices(): MobileDeviceEntry[] {
    return this.stmts.getActiveMobileDevices.all() as MobileDeviceEntry[];
  }

  revokeMobileDevice(id: string): void {
    this.stmts.revokeMobileDevice.run({ id, revoked_at: new Date().toISOString() });
  }

  cleanup(retentionDays: number): void {
    const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();
    this.stmts.cleanupAudit.run(cutoff);
    this.stmts.cleanupHitl.run(cutoff);
    this.stmts.cleanupGrants.run(cutoff);
  }

  close(): void {
    this.db.close();
  }
}
