/**
 * Hive state: SQLite, one file per hive. Shared by the hub process and every
 * hive MCP server instance (one per agent session). better-sqlite3 in WAL mode
 * handles the concurrent readers/writers fine at this scale.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Message {
  id: number;
  ts: number;
  from_agent: string;
  to_agent: string; // "*" = broadcast
  subject: string;
  body: string;
  thread: string | null;
  read_at: number | null;
}

export interface BlackboardEntry {
  key: string;
  value: string;
  updated_by: string;
  updated_at: number;
}

export interface AgentRow {
  name: string;
  kind: string;
  cwd: string;
  role: string;
  status: "idle" | "working" | "waiting" | "asleep" | "error";
  status_note: string;
  last_seen: number;
  session_id: string | null;
}

export class HiveDb {
  readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        name TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        cwd TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'idle',
        status_note TEXT NOT NULL DEFAULT '',
        last_seen INTEGER NOT NULL,
        session_id TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        thread TEXT,
        read_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS messages_inbox ON messages(to_agent, read_at);
      CREATE TABLE IF NOT EXISTS blackboard (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        agent TEXT NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL,
        prompt TEXT NOT NULL,
        kind TEXT NOT NULL,          -- 'once' | 'loop' | 'interval' | 'watch'
        remaining INTEGER,           -- loop: iterations left; null = unbounded
        until_ts INTEGER,            -- loop/interval: stop after this time
        every_ms INTEGER,            -- interval
        watch_path TEXT,             -- watch
        watch_min_lines INTEGER,     -- watch: trigger after N changed lines
        fresh_session INTEGER NOT NULL DEFAULT 1,
        next_run INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
    `);
  }

  // ---- agents ----
  upsertAgent(a: Omit<AgentRow, "last_seen">) {
    this.db
      .prepare(
        `INSERT INTO agents (name, kind, cwd, role, status, status_note, last_seen, session_id)
         VALUES (@name, @kind, @cwd, @role, @status, @status_note, @last_seen, @session_id)
         ON CONFLICT(name) DO UPDATE SET kind=excluded.kind, cwd=excluded.cwd, role=excluded.role,
           status=excluded.status, status_note=excluded.status_note, last_seen=excluded.last_seen,
           session_id=excluded.session_id`,
      )
      .run({ ...a, last_seen: Date.now() });
  }
  setStatus(name: string, status: AgentRow["status"], note = "") {
    this.db
      .prepare(`UPDATE agents SET status=?, status_note=?, last_seen=? WHERE name=?`)
      .run(status, note, Date.now(), name);
  }
  listAgents(): AgentRow[] {
    return this.db.prepare(`SELECT * FROM agents ORDER BY name`).all() as AgentRow[];
  }
  getAgent(name: string): AgentRow | undefined {
    return this.db.prepare(`SELECT * FROM agents WHERE name=?`).get(name) as AgentRow | undefined;
  }
  removeAgent(name: string) {
    this.db.prepare(`DELETE FROM agents WHERE name=?`).run(name);
  }

  // ---- messages ----
  send(from: string, to: string, subject: string, body: string, thread?: string): number {
    const r = this.db
      .prepare(
        `INSERT INTO messages (ts, from_agent, to_agent, subject, body, thread) VALUES (?,?,?,?,?,?)`,
      )
      .run(Date.now(), from, to, subject, body, thread ?? null);
    return Number(r.lastInsertRowid);
  }
  inbox(agent: string, unreadOnly = true, limit = 50): Message[] {
    const sql = unreadOnly
      ? `SELECT * FROM messages WHERE (to_agent=? OR to_agent='*') AND from_agent<>? AND read_at IS NULL ORDER BY id LIMIT ?`
      : `SELECT * FROM messages WHERE (to_agent=? OR to_agent='*') AND from_agent<>? ORDER BY id DESC LIMIT ?`;
    return this.db.prepare(sql).all(agent, agent, limit) as Message[];
  }
  unreadCount(agent: string): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages WHERE (to_agent=? OR to_agent='*') AND from_agent<>? AND read_at IS NULL`,
      )
      .get(agent, agent) as { n: number };
    return r.n;
  }
  markRead(ids: number[]) {
    if (!ids.length) return;
    const stmt = this.db.prepare(`UPDATE messages SET read_at=? WHERE id=?`);
    const now = Date.now();
    this.db.transaction(() => ids.forEach((id) => stmt.run(now, id)))();
  }
  thread(thread: string): Message[] {
    return this.db.prepare(`SELECT * FROM messages WHERE thread=? ORDER BY id`).all(thread) as Message[];
  }

  // ---- blackboard ----
  bbSet(key: string, value: string, by: string) {
    this.db
      .prepare(
        `INSERT INTO blackboard (key, value, updated_by, updated_at) VALUES (?,?,?,?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
      )
      .run(key, value, by, Date.now());
  }
  bbGet(key: string): BlackboardEntry | undefined {
    return this.db.prepare(`SELECT * FROM blackboard WHERE key=?`).get(key) as BlackboardEntry | undefined;
  }
  bbList(prefix = ""): BlackboardEntry[] {
    return this.db
      .prepare(`SELECT * FROM blackboard WHERE key LIKE ? ORDER BY key`)
      .all(prefix + "%") as BlackboardEntry[];
  }
  bbDelete(key: string) {
    this.db.prepare(`DELETE FROM blackboard WHERE key=?`).run(key);
  }

  // ---- events (append-only log) ----
  log(agent: string, type: string, data: unknown) {
    this.db
      .prepare(`INSERT INTO events (ts, agent, type, data) VALUES (?,?,?,?)`)
      .run(Date.now(), agent, type, JSON.stringify(data));
  }
  events(sinceId = 0, limit = 200) {
    return this.db
      .prepare(`SELECT * FROM events WHERE id>? ORDER BY id LIMIT ?`)
      .all(sinceId, limit) as { id: number; ts: number; agent: string; type: string; data: string }[];
  }

  close() {
    this.db.close();
  }
}
