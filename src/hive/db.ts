/**
 * Hive state: SQLite, one file per hive. Shared by the hub process and every
 * hive MCP server instance (one per agent session). better-sqlite3 in WAL mode
 * handles the concurrent readers/writers fine at this scale.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { existsSync, writeFileSync } from "node:fs";

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
  owner?: string | null;
  lease_until?: number | null;
  joined_at?: number | null;
}

export type JobKind = "once" | "loop" | "interval" | "watch";

export interface JobRow {
  id: number;
  agent: string;
  prompt: string;
  kind: JobKind;
  remaining: number | null;
  until_ts: number | null;
  every_ms: number | null;
  watch_path: string | null;
  watch_min_lines: number | null;
  fresh_session: number;
  next_run: number;
  enabled: number;
  created_at: number;
  // added in phase 2
  agent_kind: string;
  cwd: string;
  policy: string;
  role: string;
  watch_ref: string | null;
  owner: string | null;
  lease_until: number | null;
  runs: number;
  failures: number;
  last_run: number | null;
  last_error: string | null;
  ended_reason: string | null;
  briefing: string;
  worktree: number;
}

export type NewJob = Pick<JobRow, "agent" | "prompt" | "kind" | "agent_kind" | "cwd"> &
  Partial<Pick<JobRow, "remaining" | "until_ts" | "every_ms" | "watch_path" | "watch_min_lines" | "fresh_session" | "next_run" | "policy" | "role" | "briefing" | "worktree" | "owner" | "lease_until">>;

export interface JobRunRow {
  id: number;
  job_id: number;
  iteration: number;
  started: number;
  ended: number | null;
  stop_reason: string | null;
  usage: string | null;
  error: string | null;
  session_id: string | null;
  /** Tail of the agent's final reply for this run (what it found / did). */
  summary: string | null;
}

/** Broadcasts sent before an agent joined the hive aren't its mail. */
const JOINED = `COALESCE((SELECT joined_at FROM agents WHERE name=@agent), 0)`;

export class HiveDb {
  readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    // A .hive/ dir ignores itself so it never shows up in the user's git status.
    const gi = join(dirname(path), ".gitignore");
    if (basename(dirname(path)) === ".hive" && !existsSync(gi)) writeFileSync(gi, "# created by hive\n*\n");
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
      CREATE TABLE IF NOT EXISTS job_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL,
        iteration INTEGER NOT NULL,
        started INTEGER NOT NULL,
        ended INTEGER,
        stop_reason TEXT,
        usage TEXT,
        error TEXT,
        session_id TEXT
      );
      CREATE INDEX IF NOT EXISTS job_runs_job ON job_runs(job_id, id);
      -- Per-agent read state for broadcasts ('*'): one agent reading must not
      -- mark it read for everyone. Direct messages use messages.read_at.
      CREATE TABLE IF NOT EXISTS message_reads (
        message_id INTEGER NOT NULL,
        agent TEXT NOT NULL,
        read_at INTEGER NOT NULL,
        PRIMARY KEY (message_id, agent)
      );
      CREATE INDEX IF NOT EXISTS events_agent ON events(agent, id);
    `);
    // Additive column migrations for dbs created by phase 1.
    const cols = new Set((this.db.prepare(`PRAGMA table_info(jobs)`).all() as { name: string }[]).map((c) => c.name));
    const add: [string, string][] = [
      ["agent_kind", "TEXT NOT NULL DEFAULT 'claude'"],
      ["cwd", "TEXT NOT NULL DEFAULT ''"],
      ["policy", "TEXT NOT NULL DEFAULT 'allow-reads'"],
      ["role", "TEXT NOT NULL DEFAULT ''"],
      ["watch_ref", "TEXT"],
      ["owner", "TEXT"],
      ["lease_until", "INTEGER"],
      ["runs", "INTEGER NOT NULL DEFAULT 0"],
      ["failures", "INTEGER NOT NULL DEFAULT 0"],
      ["last_run", "INTEGER"],
      ["last_error", "TEXT"],
      ["ended_reason", "TEXT"],
      ["briefing", "TEXT NOT NULL DEFAULT ''"],
      ["worktree", "INTEGER NOT NULL DEFAULT 0"],
    ];
    for (const [name, type] of add) if (!cols.has(name)) this.db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${type}`);
    const agentCols = new Set((this.db.prepare(`PRAGMA table_info(agents)`).all() as { name: string }[]).map((c) => c.name));
    for (const [name, type] of [
      ["owner", "TEXT"],
      ["lease_until", "INTEGER"],
      ["joined_at", "INTEGER"],
    ] as const)
      if (!agentCols.has(name)) this.db.exec(`ALTER TABLE agents ADD COLUMN ${name} ${type}`);
    const runCols = new Set((this.db.prepare(`PRAGMA table_info(job_runs)`).all() as { name: string }[]).map((c) => c.name));
    if (!runCols.has("summary")) this.db.exec(`ALTER TABLE job_runs ADD COLUMN summary TEXT`);
  }

  // ---- agents ----
  upsertAgent(a: Omit<AgentRow, "last_seen">) {
    this.db
      .prepare(
        `INSERT INTO agents (name, kind, cwd, role, status, status_note, last_seen, session_id, joined_at)
         VALUES (@name, @kind, @cwd, @role, @status, @status_note, @last_seen, @session_id, @last_seen)
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
  /**
   * Claim the right to run agent `name` in this process (lease). Returns the
   * current owner if another live process holds it.
   */
  claimAgent(name: string, owner: string, leaseMs: number): { ok: true } | { ok: false; owner: string } {
    const now = Date.now();
    return this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO agents (name, kind, cwd, role, status, status_note, last_seen, session_id, joined_at)
           VALUES (?, '', '', '', 'asleep', '', ?, NULL, ?)`,
        )
        .run(name, now, now);
      const r = this.db
        .prepare(`UPDATE agents SET owner=?, lease_until=? WHERE name=? AND (owner IS NULL OR owner=? OR lease_until<?)`)
        .run(owner, now + leaseMs, name, owner, now);
      if (r.changes) return { ok: true as const };
      const row = this.db.prepare(`SELECT owner FROM agents WHERE name=?`).get(name) as { owner: string };
      return { ok: false as const, owner: row.owner };
    })();
  }
  renewAgents(owner: string, names: string[], leaseMs: number) {
    const stmt = this.db.prepare(`UPDATE agents SET lease_until=? WHERE name=? AND owner=?`);
    const until = Date.now() + leaseMs;
    this.db.transaction(() => names.forEach((n) => stmt.run(until, n, owner)))();
  }
  releaseAgent(name: string, owner: string) {
    this.db.prepare(`UPDATE agents SET owner=NULL, lease_until=NULL WHERE name=? AND owner=?`).run(name, owner);
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
  /**
   * Messages for `agent`: direct ones plus broadcasts from others. read_at is
   * per-agent for broadcasts (message_reads), shared for direct messages.
   */
  inbox(agent: string, unreadOnly = true, limit = 50): Message[] {
    const base = `SELECT m.id, m.ts, m.from_agent, m.to_agent, m.subject, m.body, m.thread,
        CASE WHEN m.to_agent='*' THEN r.read_at ELSE m.read_at END AS read_at
      FROM messages m LEFT JOIN message_reads r ON r.message_id=m.id AND r.agent=@agent
      WHERE (m.to_agent=@agent OR (m.to_agent='*' AND m.ts >= ${JOINED})) AND m.from_agent<>@agent`;
    const sql = unreadOnly
      ? `${base} AND (CASE WHEN m.to_agent='*' THEN r.read_at ELSE m.read_at END) IS NULL ORDER BY m.id LIMIT @limit`
      : `${base} ORDER BY m.id DESC LIMIT @limit`;
    return this.db.prepare(sql).all({ agent, limit }) as Message[];
  }
  unreadCount(agent: string): number {
    return this.unreadRows(agent).length;
  }
  private unreadRows(agent: string): { from_agent: string; subject: string }[] {
    return this.db
      .prepare(
        `SELECT m.from_agent, m.subject FROM messages m
         LEFT JOIN message_reads r ON r.message_id=m.id AND r.agent=@agent
         WHERE (m.to_agent=@agent OR (m.to_agent='*' AND m.ts >= ${JOINED})) AND m.from_agent<>@agent
           AND (CASE WHEN m.to_agent='*' THEN r.read_at ELSE m.read_at END) IS NULL
         ORDER BY m.id`,
      )
      .all({ agent }) as { from_agent: string; subject: string }[];
  }
  /** Unread mail grouped by sender, for the wake-up prompt. */
  unreadSummary(agent: string): { from: string; count: number; subjects: string[] }[] {
    const by = new Map<string, { from: string; count: number; subjects: string[] }>();
    for (const r of this.unreadRows(agent)) {
      const e = by.get(r.from_agent) ?? { from: r.from_agent, count: 0, subjects: [] };
      e.count++;
      e.subjects.push(r.subject);
      by.set(r.from_agent, e);
    }
    return [...by.values()];
  }
  /** Mark messages read by `agent` (broadcasts only for that agent). */
  markRead(ids: number[], agent?: string) {
    if (!ids.length) return;
    const now = Date.now();
    const direct = this.db.prepare(`UPDATE messages SET read_at=? WHERE id=? AND to_agent<>'*'`);
    const bcast = this.db.prepare(
      `INSERT OR IGNORE INTO message_reads (message_id, agent, read_at) SELECT id, ?, ? FROM messages WHERE id=? AND to_agent='*'`,
    );
    this.db.transaction(() =>
      ids.forEach((id) => {
        direct.run(now, id);
        if (agent) bcast.run(agent, now, id);
      }),
    )();
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

  // ---- jobs (scheduler) ----
  addJob(j: NewJob): number {
    const r = this.db
      .prepare(
        `INSERT INTO jobs (agent, prompt, kind, remaining, until_ts, every_ms, watch_path, watch_min_lines,
           fresh_session, next_run, enabled, created_at, agent_kind, cwd, policy, role, briefing, worktree, owner, lease_until)
         VALUES (@agent, @prompt, @kind, @remaining, @until_ts, @every_ms, @watch_path, @watch_min_lines,
           @fresh_session, @next_run, 1, @created_at, @agent_kind, @cwd, @policy, @role, @briefing, @worktree, @owner, @lease_until)`,
      )
      .run({
        remaining: null,
        until_ts: null,
        every_ms: null,
        watch_path: null,
        watch_min_lines: null,
        fresh_session: 1,
        next_run: Date.now(),
        policy: "allow-reads",
        role: "",
        briefing: "",
        worktree: 0,
        owner: null,
        lease_until: null,
        ...j,
        created_at: Date.now(),
      });
    return Number(r.lastInsertRowid);
  }
  getJob(id: number): JobRow | undefined {
    return this.db.prepare(`SELECT * FROM jobs WHERE id=?`).get(id) as JobRow | undefined;
  }
  listJobs(includeEnded = true): JobRow[] {
    return this.db
      .prepare(includeEnded ? `SELECT * FROM jobs ORDER BY id` : `SELECT * FROM jobs WHERE enabled=1 ORDER BY id`)
      .all() as JobRow[];
  }
  updateJob(id: number, patch: Partial<Omit<JobRow, "id">>) {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    this.db.prepare(`UPDATE jobs SET ${keys.map((k) => `${k}=@${k}`).join(", ")} WHERE id=@id`).run({ ...patch, id });
  }
  /** Disable a job and record why ('done', 'stopped', 'until', 'failed'). */
  endJob(id: number, reason: string) {
    this.db.prepare(`UPDATE jobs SET enabled=0, ended_reason=?, owner=NULL, lease_until=NULL WHERE id=?`).run(reason, id);
  }
  /**
   * Atomically claim enabled jobs for this scheduler (owner), or renew our
   * lease. A job owned by another live scheduler is left alone, so `hive serve`
   * and a foreground `hive loop` never run the same job twice.
   */
  claimJobs(owner: string, leaseMs: number, onlyIds?: number[], skipIds: number[] = []): JobRow[] {
    const now = Date.now();
    return this.db.transaction(() => {
      let filter = onlyIds ? ` AND id IN (${onlyIds.map(Number).join(",") || "NULL"})` : "";
      if (skipIds.length) filter += ` AND id NOT IN (${skipIds.map(Number).join(",")})`;
      this.db
        .prepare(
          `UPDATE jobs SET owner=?, lease_until=? WHERE enabled=1 AND (owner IS NULL OR owner=? OR lease_until<?)${filter}`,
        )
        .run(owner, now + leaseMs, owner, now);
      return this.db.prepare(`SELECT * FROM jobs WHERE enabled=1 AND owner=?${filter} ORDER BY id`).all(owner) as JobRow[];
    })();
  }
  renewLeases(owner: string, leaseMs: number) {
    this.db.prepare(`UPDATE jobs SET lease_until=? WHERE owner=? AND enabled=1`).run(Date.now() + leaseMs, owner);
  }
  releaseJobs(owner: string) {
    this.db.prepare(`UPDATE jobs SET owner=NULL, lease_until=NULL WHERE owner=?`).run(owner);
  }
  startRun(jobId: number, iteration: number, sessionId: string | null): number {
    const r = this.db
      .prepare(`INSERT INTO job_runs (job_id, iteration, started, session_id) VALUES (?,?,?,?)`)
      .run(jobId, iteration, Date.now(), sessionId);
    return Number(r.lastInsertRowid);
  }
  endRun(runId: number, r: { stopReason?: string; usage?: unknown; error?: string; summary?: string; sessionId?: string }) {
    this.db
      .prepare(`UPDATE job_runs SET ended=?, stop_reason=?, usage=?, error=?, summary=?, session_id=COALESCE(?, session_id) WHERE id=?`)
      .run(
        Date.now(),
        r.stopReason ?? null,
        r.usage == null ? null : JSON.stringify(r.usage),
        r.error ?? null,
        r.summary ? r.summary.slice(-2000) : null,
        r.sessionId ?? null,
        runId,
      );
  }
  jobRuns(jobId: number, limit = 50): JobRunRow[] {
    return this.db
      .prepare(`SELECT * FROM job_runs WHERE job_id=? ORDER BY id DESC LIMIT ?`)
      .all(jobId, limit) as JobRunRow[];
  }

  /** Drop events (and finished job runs) older than `days`. */
  prune(days = 30) {
    const cutoff = Date.now() - days * 86_400_000;
    this.db.prepare(`DELETE FROM events WHERE ts < ?`).run(cutoff);
    this.db.prepare(`DELETE FROM job_runs WHERE ended IS NOT NULL AND ended < ?`).run(cutoff);
    this.db.prepare(`DELETE FROM message_reads WHERE read_at < ?`).run(cutoff);
  }
  messagesSince(ts: number, limit = 500): Message[] {
    return this.db.prepare(`SELECT * FROM messages WHERE ts>=? ORDER BY id DESC LIMIT ?`).all(ts, limit) as Message[];
  }
  runsSince(ts: number): (JobRunRow & { agent: string; kind: string; prompt: string })[] {
    return this.db
      .prepare(
        `SELECT r.*, j.agent, j.kind, j.prompt FROM job_runs r JOIN jobs j ON j.id=r.job_id WHERE r.started>=? ORDER BY r.id`,
      )
      .all(ts) as any;
  }
  bbSince(ts: number): BlackboardEntry[] {
    return this.db.prepare(`SELECT * FROM blackboard WHERE updated_at>=? ORDER BY key`).all(ts) as BlackboardEntry[];
  }
  threadLength(thread: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE thread=?`).get(thread) as { n: number }).n;
  }

  /** Recent events for one agent, oldest first (UI history). */
  agentEvents(agent: string, types: string[], limit = 200) {
    const rows = this.db
      .prepare(
        `SELECT * FROM events WHERE agent=? AND type IN (${types.map(() => "?").join(",")}) ORDER BY id DESC LIMIT ?`,
      )
      .all(agent, ...types, limit) as { id: number; ts: number; agent: string; type: string; data: string }[];
    return rows.reverse();
  }

  close() {
    if (this.db.open) this.db.close();
  }
}
