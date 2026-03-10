import Database from 'better-sqlite3';

export interface AuditEntry {
  id?: number;
  ts: string;          // ISO timestamp
  agent_id: string;
  tool: string;
  args: string;        // JSON string
  result: string;      // 'success' | 'error' | 'denied' | 'hitl_approved' | 'hitl_denied' | 'hitl_timeout'
  error?: string;
  duration_ms?: number;
  hitl_code?: string;
}

export interface HitlQueueEntry {
  id: string;
  code: string;
  agent_id: string;
  tool: string;
  args: string;        // JSON string
  status: 'pending' | 'approved' | 'denied' | 'timeout';
  reason?: string;
  created_at: string;
  resolved_at?: string;
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
    cleanupAudit: Database.Statement;
    cleanupHitl: Database.Statement;
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
        hitl_code   TEXT
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
    `);
  }

  private prepareStatements(): void {
    this.stmts = {
      insertAudit: this.db.prepare(`
        INSERT INTO audit_log (ts, agent_id, tool, args, result, error, duration_ms, hitl_code)
        VALUES (@ts, @agent_id, @tool, @args, @result, @error, @duration_ms, @hitl_code)
      `),
      insertHitl: this.db.prepare(`
        INSERT INTO hitl_queue (id, code, agent_id, tool, args, status, created_at)
        VALUES (@id, @code, @agent_id, @tool, @args, @status, @created_at)
      `),
      updateHitlStatus: this.db.prepare(`
        UPDATE hitl_queue SET status = @status, reason = @reason, resolved_at = @resolved_at WHERE id = @id
      `),
      getHitlByCode: this.db.prepare('SELECT * FROM hitl_queue WHERE code = ?'),
      getHitlById: this.db.prepare('SELECT * FROM hitl_queue WHERE id = ?'),
      getPendingHitl: this.db.prepare("SELECT * FROM hitl_queue WHERE status = 'pending' ORDER BY created_at ASC"),
      cleanupAudit: this.db.prepare('DELETE FROM audit_log WHERE ts < ?'),
      cleanupHitl: this.db.prepare("DELETE FROM hitl_queue WHERE status != 'pending' AND resolved_at < ?"),
    };
  }

  insertAudit(entry: Omit<AuditEntry, 'id'>): void {
    this.stmts.insertAudit.run({
      error: null,
      duration_ms: null,
      hitl_code: null,
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

    if (filters.agent) { conditions.push('agent_id = @agent'); params.agent = filters.agent; }
    if (filters.tool)  { conditions.push('tool = @tool');      params.tool  = filters.tool;  }
    if (filters.since) { conditions.push('ts >= @since');      params.since = filters.since; }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(filters.limit ?? 100, 10000));
    params.limit = limit;

    return this.db.prepare(
      `SELECT * FROM audit_log ${where} ORDER BY ts DESC LIMIT @limit`
    ).all(params) as AuditEntry[];
  }

  insertHitl(entry: HitlQueueEntry): void {
    this.stmts.insertHitl.run(entry);
  }

  updateHitlStatus(id: string, status: HitlQueueEntry['status'], reason?: string): void {
    this.stmts.updateHitlStatus.run({ id, status, reason: reason ?? null, resolved_at: new Date().toISOString() });
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

  cleanup(retentionDays: number): void {
    const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();
    this.stmts.cleanupAudit.run(cutoff);
    this.stmts.cleanupHitl.run(cutoff);
  }

  close(): void {
    this.db.close();
  }
}
