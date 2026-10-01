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
  /** Why it isn't delivered yet (waiting for the owner), or null. */
  held?: string | null;
  /** Group the message was routed through, if any. */
  via?: string | null;
}

export type GroupMode = "direct" | "review";
export interface GroupSettings {
  mode: GroupMode;
  /** Max agent-to-agent messages per hour through this group; more are held. */
  max_per_hour: number | null;
}
export type Route = { ok: false; reason: string } | { ok: true; held?: string; via?: string };
/** "open": agents can message anyone; "linked": only agents they share a group with (plus the owner). */
export type MailScope = "open" | "linked";

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
  pid?: number | null;
  policy?: string | null;
  preset?: string | null;
  briefing?: string | null;
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
  /** watch jobs: minimum time between runs (review at most every N). */
  cooldown_ms: number | null;
}

export type NewJob = Pick<JobRow, "agent" | "prompt" | "kind" | "agent_kind" | "cwd"> &
  Partial<Pick<JobRow, "remaining" | "until_ts" | "every_ms" | "watch_path" | "watch_min_lines" | "fresh_session" | "next_run" | "policy" | "role" | "briefing" | "worktree" | "owner" | "lease_until" | "cooldown_ms">>;

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
/** The human ("owner") gets mail addressed to "owner", not agents' broadcasts. */
const BCAST = `(((m.to_agent='*' AND @agent<>'owner' AND m.ts >= ${JOINED}) OR (m.to_agent LIKE '@%' AND EXISTS (SELECT 1 FROM group_members g WHERE g.grp=substr(m.to_agent,2) AND g.member=@agent AND m.ts >= g.added_at)))
  AND NOT EXISTS (SELECT 1 FROM message_reads s WHERE s.message_id=m.id AND s.agent=@agent AND s.read_at=0))`;
/** Messages delivered to many (broadcast "*" or a group "@name") keep read state per agent.
 *  A message_reads row with read_at=0 means "not for this agent" (a guarded copy went to review instead). */
const SHARED = `(m.to_agent='*' OR m.to_agent LIKE '@%')`;

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
      -- Usage per finished turn (tokens / cost) and provider limit windows.
      CREATE TABLE IF NOT EXISTS usage_log (
        ts INTEGER NOT NULL,
        agent TEXT NOT NULL,
        provider TEXT NOT NULL,
        tokens INTEGER NOT NULL,
        cost_usd REAL NOT NULL DEFAULT 0,
        automatic INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS usage_log_ts ON usage_log(ts);
      CREATE TABLE IF NOT EXISTS limits (
        provider TEXT NOT NULL,
        window TEXT NOT NULL,
        utilization REAL,
        resets_at INTEGER,
        status TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (provider, window)
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      -- Media API calls requested by agents, run by a hive process that has the keys
      -- (so API keys never reach vendor agent processes).
      CREATE TABLE IF NOT EXISTS media_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        agent TEXT NOT NULL,
        kind TEXT NOT NULL,
        params TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        result TEXT,
        error TEXT
      );
      -- Groups: mail to "@<group>" reaches every member (agents or "owner").
      CREATE TABLE IF NOT EXISTS group_members (
        grp TEXT NOT NULL,
        member TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (grp, member)
      );
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
      ["cooldown_ms", "INTEGER"],
    ];
    for (const [name, type] of add) if (!cols.has(name)) this.db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${type}`);
    const agentCols = new Set((this.db.prepare(`PRAGMA table_info(agents)`).all() as { name: string }[]).map((c) => c.name));
    for (const [name, type] of [
      ["owner", "TEXT"],
      ["lease_until", "INTEGER"],
      ["joined_at", "INTEGER"],
      ["pid", "INTEGER"],
      ["policy", "TEXT"],
      ["preset", "TEXT"],
      ["briefing", "TEXT"],
    ] as const)
      if (!agentCols.has(name)) this.db.exec(`ALTER TABLE agents ADD COLUMN ${name} ${type}`);
    const runCols = new Set((this.db.prepare(`PRAGMA table_info(job_runs)`).all() as { name: string }[]).map((c) => c.name));
    if (!runCols.has("summary")) this.db.exec(`ALTER TABLE job_runs ADD COLUMN summary TEXT`);
    const msgCols = new Set((this.db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[]).map((c) => c.name));
    if (!msgCols.has("held")) this.db.exec(`ALTER TABLE messages ADD COLUMN held TEXT`);
    if (!msgCols.has("via")) this.db.exec(`ALTER TABLE messages ADD COLUMN via TEXT`);
    // Who added a group member: 'owner' (or a row from before this column) = a link the human made or approved.
    const gmCols = new Set((this.db.prepare(`PRAGMA table_info(group_members)`).all() as { name: string }[]).map((c) => c.name));
    if (!gmCols.has("added_by")) this.db.exec(`ALTER TABLE group_members ADD COLUMN added_by TEXT NOT NULL DEFAULT 'owner'`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS messages_held ON messages(held) WHERE held IS NOT NULL`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS messages_via ON messages(via, ts) WHERE via IS NOT NULL`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS verdicts (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, state TEXT NOT NULL)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS group_settings (grp TEXT PRIMARY KEY, mode TEXT NOT NULL DEFAULT 'direct', max_per_hour INTEGER)`);
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
  /** Forget an agent — unless another live process holds its lease. */
  removeAgent(name: string, owner?: string) {
    this.db
      .prepare(`DELETE FROM agents WHERE name=? AND (owner IS NULL OR owner=? OR lease_until<?)`)
      .run(name, owner ?? "", Date.now());
  }
  /** How to start this agent again (any process: serve, CLI, UI). */
  setAgentConfig(name: string, policy: string, preset: string | null, briefing?: string | null) {
    this.db.prepare(`UPDATE agents SET policy=?, preset=?, briefing=COALESCE(?, briefing) WHERE name=?`).run(policy, preset, briefing ?? null, name);
  }
  /** Status as others should see it: a dead owner means asleep, whatever the row says. */
  effectiveStatus(a: AgentRow): AgentRow["status"] {
    if (a.status === "asleep") return a.status;
    if (!a.owner || (a.lease_until ?? 0) < Date.now()) return "asleep";
    return a.status;
  }
  setPid(name: string, pid: number | null) {
    this.db.prepare(`UPDATE agents SET pid=? WHERE name=?`).run(pid, name);
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
    // A placeholder from claimAgent whose start failed never became an agent.
    this.db.prepare(`DELETE FROM agents WHERE name=? AND owner=? AND kind=''`).run(name, owner);
    this.db.prepare(`UPDATE agents SET owner=NULL, lease_until=NULL WHERE name=? AND owner=?`).run(name, owner);
  }

  // ---- messages ----
  send(from: string, to: string, subject: string, body: string, thread?: string, o: { held?: string; via?: string } = {}): number {
    const r = this.db
      .prepare(
        `INSERT INTO messages (ts, from_agent, to_agent, subject, body, thread, held, via) VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(Date.now(), from, to, subject, body, thread ?? null, o.held ?? null, o.via ?? null);
    return Number(r.lastInsertRowid);
  }

  // ---- the layer between agents: scope, group modes, held mail ----
  mailScope(): MailScope {
    return this.getSetting("mail.scope") === "linked" ? "linked" : "open";
  }
  /** Hold mail from unlinked agents to allow-all agents (default on). */
  guardAllowAll(): boolean {
    return this.getSetting("mail.guard_allow_all") !== "off";
  }
  setGuardAllowAll(on: boolean) {
    this.setSetting("mail.guard_allow_all", on ? null : "off");
  }
  setMailScope(scope: MailScope) {
    this.setSetting("mail.scope", scope === "linked" ? "linked" : null);
  }
  groupSettings(grp: string): GroupSettings {
    const r = this.db.prepare(`SELECT mode, max_per_hour FROM group_settings WHERE grp=?`).get(grp) as GroupSettings | undefined;
    return { mode: r?.mode === "review" ? "review" : "direct", max_per_hour: r?.max_per_hour ?? null };
  }
  setGroupSettings(grp: string, s: Partial<GroupSettings>) {
    const cur = this.groupSettings(grp);
    const next = { ...cur, ...s };
    this.db
      .prepare(`INSERT INTO group_settings (grp, mode, max_per_hour) VALUES (?,?,?) ON CONFLICT(grp) DO UPDATE SET mode=excluded.mode, max_per_hour=excluded.max_per_hour`)
      .run(grp, next.mode, next.max_per_hour && next.max_per_hour > 0 ? Math.floor(next.max_per_hour) : null);
  }
  private overCap(grp: string, max: number | null): boolean {
    if (!max) return false;
    const n = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE via=? AND from_agent<>'owner' AND held IS NULL AND ts>?`).get(grp, Date.now() - 3_600_000) as { n: number }
    ).n;
    return n >= max;
  }
  private throughGroup(grp: string): Route {
    const s = this.groupSettings(grp);
    if (s.mode === "review") return { ok: true, held: `waiting for the human's review in @${grp}`, via: grp };
    if (this.overCap(grp, s.max_per_hour)) return { ok: true, held: `@${grp} reached its limit of ${s.max_per_hour} agent messages per hour`, via: grp };
    return { ok: true, via: grp };
  }
  /** Is `name` an agent that may run anything (and so only takes mail from agents the owner linked it with)? */
  isGuarded(name: string): boolean {
    return name !== "owner" && this.guardAllowAll() && this.getAgent(name)?.policy === "allow-all";
  }
  /** Do `a` and `b` share a group whose membership the owner made or approved (not one agents built themselves)? */
  ownerLinked(a: string, b: string): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM group_members x JOIN group_members y ON x.grp=y.grp WHERE x.member=? AND y.member=? AND x.added_by='owner' AND y.added_by='owner' LIMIT 1`)
      .get(a, b);
  }
  private guardHeld(from: string, to: string): string {
    return `${to} can run anything and isn't linked with ${from}; waiting for your review`;
  }
  /**
   * Mail to many ("*" or "@group") from an agent: allow-all recipients the owner
   * hasn't linked with the sender don't get it; each gets a held copy for the
   * owner's review instead. Returns those recipients.
   */
  guardShared(id: number): string[] {
    const m = this.db.prepare(`SELECT * FROM messages WHERE id=?`).get(id) as Message | undefined;
    if (!m || m.from_agent === "owner" || m.held || !(m.to_agent === "*" || m.to_agent.startsWith("@")) || !this.guardAllowAll()) return [];
    const to = m.to_agent === "*" ? this.listAgents().map((a) => a.name) : this.groupMembers(m.to_agent.slice(1));
    const guarded = to.filter((r) => r !== m.from_agent && this.isGuarded(r) && !this.ownerLinked(m.from_agent, r));
    const skip = this.db.prepare(`INSERT OR REPLACE INTO message_reads (message_id, agent, read_at) VALUES (?,?,0)`);
    this.db.transaction(() => {
      for (const r of guarded) {
        skip.run(id, r);
        this.send(m.from_agent, r, m.subject, m.body, m.thread ?? undefined, { held: `${this.guardHeld(m.from_agent, r)} (sent to ${m.to_agent})`, via: m.via ?? undefined });
      }
    })();
    return guarded;
  }
  /**
   * May `from` message `to`, and is it delivered now or held for the owner?
   * The owner is never restricted, and agents can always reach the owner.
   * Mail to many reaching allow-all agents is guarded per recipient: see guardShared.
   */
  route(from: string, to: string): Route {
    if (from === "owner" || to === "owner") return { ok: true };
    const linked = this.mailScope() === "linked";
    const mine = this.groups().filter((g) => g.members.includes(from));
    const list = mine.map((g) => "@" + g.name).join(", ") || "none";
    if (to === "*") return linked ? { ok: false, reason: `Agents here only talk to agents they're linked with (your groups: ${list}). Use @group, or hive_send to "owner".` } : { ok: true };
    if (to.startsWith("@")) {
      const g = to.slice(1);
      const members = this.groupMembers(g);
      if (linked && !members.includes(from)) return { ok: false, reason: `You're not in ${to}. Your groups: ${list}.` };
      return this.throughGroup(g);
    }
    const shared = mine.filter((g) => g.members.includes(to));
    if (linked && !shared.length) return { ok: false, reason: `You aren't linked with ${to}; only the human links agents. Your groups: ${list}. Ask the owner if you need ${to}.` };
    // An agent that may run anything only takes orders from agents you linked it with
    // (a group agents built themselves doesn't count): mail from anyone else waits for
    // you, so a peer can't steer it into running commands.
    if (this.isGuarded(to) && !this.ownerLinked(from, to)) return { ok: true, held: this.guardHeld(from, to) };
    if (!shared.length) return { ok: true };
    // The most permissive shared group wins: a direct group under its cap delivers now.
    const routes = shared.map((g) => this.throughGroup(g.name));
    return routes.find((r) => r.ok && !r.held) ?? routes[0];
  }
  // ---- verdict rounds (state is JSON, see core/verdict.ts) ----
  addVerdict(state: object): number {
    return Number(this.db.prepare(`INSERT INTO verdicts (ts, state) VALUES (?, ?)`).run(Date.now(), JSON.stringify(state)).lastInsertRowid);
  }
  saveVerdict(id: number, state: object) {
    this.db.prepare(`UPDATE verdicts SET state=? WHERE id=?`).run(JSON.stringify(state), id);
  }
  getVerdict<T>(id: number): T | undefined {
    const r = this.db.prepare(`SELECT state FROM verdicts WHERE id=?`).get(id) as { state: string } | undefined;
    return r ? (JSON.parse(r.state) as T) : undefined;
  }
  listVerdicts<T>(limit = 20): T[] {
    return (this.db.prepare(`SELECT state FROM verdicts ORDER BY id DESC LIMIT ?`).all(limit) as { state: string }[]).map((r) => JSON.parse(r.state) as T);
  }
  heldMessages(): Message[] {
    return this.db.prepare(`SELECT * FROM messages WHERE held IS NOT NULL ORDER BY id`).all() as Message[];
  }
  /** Deliver a held message now (optionally edited). */
  releaseMessage(id: number, body?: string): boolean {
    const r = this.db
      .prepare(`UPDATE messages SET held=NULL, ts=?, body=COALESCE(?, body) WHERE id=? AND held IS NOT NULL`)
      .run(Date.now(), body ?? null, id);
    return r.changes > 0;
  }
  dropMessage(id: number): boolean {
    return this.db.prepare(`DELETE FROM messages WHERE id=? AND held IS NOT NULL`).run(id).changes > 0;
  }
  /** Conversation of a group: mail to @grp, mail routed through it, and mail between its members. */
  groupMessages(grp: string, limit = 200): Message[] {
    const members = this.groupMembers(grp);
    const ph = members.map(() => "?").join(",") || "''";
    // Union of indexed lookups rather than one OR across the table.
    return (
      this.db
        .prepare(
          `SELECT * FROM messages WHERE id IN (
             SELECT id FROM messages WHERE to_agent=?
             UNION SELECT id FROM messages WHERE via=?
             UNION SELECT id FROM messages WHERE to_agent IN (${ph}) AND from_agent IN (${ph}) AND to_agent<>from_agent
           ) ORDER BY id DESC LIMIT ?`,
        )
        .all("@" + grp, grp, ...members, ...members, limit) as Message[]
    ).reverse();
  }

  /**
   * Messages for `agent`: direct ones plus broadcasts from others. read_at is
   * per-agent for broadcasts (message_reads), shared for direct messages.
   */
  inbox(agent: string, unreadOnly = true, limit = 50): Message[] {
    const base = `SELECT m.id, m.ts, m.from_agent, m.to_agent, m.subject, m.body, m.thread, m.via,
        CASE WHEN ${SHARED} THEN r.read_at ELSE m.read_at END AS read_at
      FROM messages m LEFT JOIN message_reads r ON r.message_id=m.id AND r.agent=@agent
      WHERE (m.to_agent=@agent OR ${BCAST}) AND m.from_agent<>@agent AND m.held IS NULL`;
    const sql = unreadOnly
      ? `${base} AND (CASE WHEN ${SHARED} THEN r.read_at ELSE m.read_at END) IS NULL ORDER BY m.id LIMIT @limit`
      : `${base} ORDER BY m.id DESC LIMIT @limit`;
    return this.db.prepare(sql).all({ agent, limit }) as Message[];
  }
  unreadCount(agent: string): number {
    return this.unreadRows(agent).length;
  }
  private unreadRows(agent: string): { from_agent: string; subject: string; to_agent: string }[] {
    // Two indexed halves instead of one OR over the whole table: direct mail
    // (to_agent=me, read_at IS NULL) and shared mail ("*" or "@group", a to_agent range).
    return this.db
      .prepare(
        `SELECT id, from_agent, subject, to_agent FROM (
           SELECT m.id, m.from_agent, m.subject, m.to_agent FROM messages m
            WHERE m.to_agent=@agent AND m.read_at IS NULL AND m.held IS NULL AND m.from_agent<>@agent
           UNION ALL
           SELECT m.id, m.from_agent, m.subject, m.to_agent FROM messages m
            LEFT JOIN message_reads r ON r.message_id=m.id AND r.agent=@agent
            WHERE (m.to_agent='*' OR (m.to_agent >= '@' AND m.to_agent < 'A')) AND ${BCAST}
              AND r.read_at IS NULL AND m.held IS NULL AND m.from_agent<>@agent
         ) ORDER BY id`,
      )
      .all({ agent }) as { from_agent: string; subject: string; to_agent: string }[];
  }

  /** Unread mail grouped by sender, for the wake-up prompt. */
  unreadSummary(agent: string): { from: string; count: number; subjects: string[] }[] {
    const by = new Map<string, { from: string; count: number; subjects: string[] }>();
    for (const r of this.unreadRows(agent)) {
      const from = r.to_agent.startsWith("@") ? `${r.from_agent} via ${r.to_agent}` : r.from_agent;
      const e = by.get(from) ?? { from, count: 0, subjects: [] };
      e.count++;
      e.subjects.push(r.subject);
      by.set(from, e);
    }
    return [...by.values()];
  }
  /** Mark messages read by `agent` (broadcasts only for that agent). */
  markRead(ids: number[], agent?: string) {
    if (!ids.length) return;
    const now = Date.now();
    const direct = this.db.prepare(`UPDATE messages SET read_at=? WHERE id=? AND to_agent<>'*' AND to_agent NOT LIKE '@%'`);
    const bcast = this.db.prepare(
      `INSERT OR IGNORE INTO message_reads (message_id, agent, read_at) SELECT id, ?, ? FROM messages WHERE id=? AND (to_agent='*' OR to_agent LIKE '@%')`,
    );
    this.db.transaction(() =>
      ids.forEach((id) => {
        direct.run(now, id);
        if (agent) bcast.run(agent, now, id);
      }),
    )();
  }
  /** A thread as `agent` may see it: mail it sent or received (broadcasts, its groups), nothing held. */
  thread(thread: string, agent: string): Message[] {
    return this.db
      .prepare(`SELECT m.* FROM messages m WHERE m.thread=@thread AND m.held IS NULL AND (m.from_agent=@agent OR m.to_agent=@agent OR ${BCAST}) ORDER BY m.id`)
      .all({ thread, agent }) as Message[];
  }

  // ---- usage, limits, settings ----
  recordUsage(agent: string, provider: string, tokens: number, costUsd = 0, automatic = false) {
    this.db
      .prepare(`INSERT INTO usage_log (ts, agent, provider, tokens, cost_usd, automatic) VALUES (?,?,?,?,?,?)`)
      .run(Date.now(), agent, provider, Math.max(0, Math.round(tokens)), costUsd, automatic ? 1 : 0);
  }
  /** Tokens and cost since `since`, per provider (optionally only automatic work). */
  usageSince(since: number, automaticOnly = false): { provider: string; tokens: number; cost: number; turns: number }[] {
    return this.db
      .prepare(
        `SELECT provider, SUM(tokens) AS tokens, SUM(cost_usd) AS cost, COUNT(*) AS turns FROM usage_log WHERE ts>=?${automaticOnly ? " AND automatic=1" : ""} GROUP BY provider ORDER BY provider`,
      )
      .all(since) as { provider: string; tokens: number; cost: number; turns: number }[];
  }
  setLimit(provider: string, window: string, l: { utilization?: number | null; resets_at?: number | null; status?: string | null }) {
    this.db
      .prepare(
        `INSERT INTO limits (provider, window, utilization, resets_at, status, updated_at) VALUES (@provider,@window,@u,@r,@s,@t)
         ON CONFLICT(provider, window) DO UPDATE SET utilization=COALESCE(excluded.utilization, utilization),
           resets_at=COALESCE(excluded.resets_at, resets_at), status=COALESCE(excluded.status, status), updated_at=excluded.updated_at`,
      )
      .run({ provider, window, u: l.utilization ?? null, r: l.resets_at ?? null, s: l.status ?? null, t: Date.now() });
  }
  limits(): { provider: string; window: string; utilization: number | null; resets_at: number | null; status: string | null; updated_at: number }[] {
    return this.db.prepare(`SELECT * FROM limits ORDER BY provider, window`).all() as any;
  }
  addMedia(agent: string, kind: string, params: unknown): number {
    return Number(this.db.prepare(`INSERT INTO media_jobs (ts, agent, kind, params) VALUES (?,?,?,?)`).run(Date.now(), agent, kind, JSON.stringify(params)).lastInsertRowid);
  }
  /** Atomically take the oldest pending media job of the given kinds. */
  claimMedia(kinds: string[]): { id: number; agent: string; kind: string; params: string } | undefined {
    if (!kinds.length) return undefined;
    return this.db.transaction(() => {
      const row = this.db
        .prepare(`SELECT id, agent, kind, params FROM media_jobs WHERE status='pending' AND kind IN (${kinds.map(() => "?").join(",")}) ORDER BY id LIMIT 1`)
        .get(...kinds) as { id: number; agent: string; kind: string; params: string } | undefined;
      if (row) this.db.prepare(`UPDATE media_jobs SET status='running' WHERE id=?`).run(row.id);
      return row;
    })();
  }
  /** Media jobs claimed before `id` that are still running (they hold a slot of the daily cap). */
  runningMedia(id: number): { id: number; kind: string; params: string }[] {
    return this.db.prepare(`SELECT id, kind, params FROM media_jobs WHERE status='running' AND id<? AND ts>=?`).all(id, Date.now() - 86_400_000) as any;
  }
  finishMedia(id: number, result: string | null, error: string | null) {
    this.db.prepare(`UPDATE media_jobs SET status=?, result=?, error=? WHERE id=?`).run(error ? "failed" : "done", result, error, id);
  }
  getMedia(id: number): { status: string; result: string | null; error: string | null } | undefined {
    return this.db.prepare(`SELECT status, result, error FROM media_jobs WHERE id=?`).get(id) as any;
  }
  getSetting(key: string): string | undefined {
    return (this.db.prepare(`SELECT value FROM settings WHERE key=?`).get(key) as { value: string } | undefined)?.value;
  }
  setSetting(key: string, value: string | null) {
    if (value === null) this.db.prepare(`DELETE FROM settings WHERE key=?`).run(key);
    else this.db.prepare(`INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, value);
  }
  settings(prefix = ""): Record<string, string> {
    const rows = this.db.prepare(`SELECT key, value FROM settings WHERE key LIKE ?`).all(prefix + "%") as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  // ---- groups ----
  /** Add members; `by` is the agent doing it, or "owner" (the human), whose change approves the whole group. */
  addToGroup(grp: string, members: string[], by = "owner") {
    const stmt = this.db.prepare(`INSERT OR IGNORE INTO group_members (grp, member, added_at, added_by) VALUES (?,?,?,?)`);
    const now = Date.now();
    this.db.transaction(() => {
      members.forEach((m) => stmt.run(grp, m, now, by));
      if (by === "owner") this.db.prepare(`UPDATE group_members SET added_by='owner' WHERE grp=?`).run(grp);
    })();
  }
  removeFromGroup(grp: string, member: string) {
    this.db.prepare(`DELETE FROM group_members WHERE grp=? AND member=?`).run(grp, member);
  }
  /** Messages still waiting for the owner that were routed through (or sent to) a group. */
  heldInGroup(grp: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE held IS NOT NULL AND (via=? OR to_agent=?)`).get(grp, "@" + grp) as { n: number }).n;
  }
  deleteGroup(grp: string) {
    // Held mail would be stranded (no group chat to release it from): decide on it first.
    const held = this.heldInGroup(grp);
    if (held) throw new Error(`@${grp} has ${held} message${held === 1 ? "" : "s"} waiting for your review; release or drop ${held === 1 ? "it" : "them"} first`);
    this.db.prepare(`DELETE FROM group_members WHERE grp=?`).run(grp);
    this.db.prepare(`DELETE FROM group_settings WHERE grp=?`).run(grp);
  }
  groups(): { name: string; members: string[] }[] {
    const rows = this.db.prepare(`SELECT grp, member FROM group_members ORDER BY grp, member`).all() as { grp: string; member: string }[];
    const by = new Map<string, string[]>();
    for (const r of rows) by.set(r.grp, [...(by.get(r.grp) ?? []), r.member]);
    return [...by].map(([name, members]) => ({ name, members }));
  }
  groupMembers(grp: string): string[] {
    return (this.db.prepare(`SELECT member FROM group_members WHERE grp=? ORDER BY member`).all(grp) as { member: string }[]).map((r) => r.member);
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
           fresh_session, next_run, enabled, created_at, agent_kind, cwd, policy, role, briefing, worktree, owner, lease_until, cooldown_ms)
         VALUES (@agent, @prompt, @kind, @remaining, @until_ts, @every_ms, @watch_path, @watch_min_lines,
           @fresh_session, @next_run, 1, @created_at, @agent_kind, @cwd, @policy, @role, @briefing, @worktree, @owner, @lease_until, @cooldown_ms)`,
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
        cooldown_ms: null,
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
    // message_reads go only with their message: dropping them alone would make old broadcasts unread again.
    this.db.prepare(`DELETE FROM usage_log WHERE ts < ?`).run(Date.now() - Math.max(days, 35) * 86_400_000);
    this.db.prepare(`DELETE FROM media_jobs WHERE ts < ?`).run(Date.now() - 86_400_000);
    // Old mail that's been read (and group/broadcast mail) goes after 90 days; unread and held mail stays.
    const old = Date.now() - Math.max(days, 90) * 86_400_000;
    this.db
      .prepare(`DELETE FROM messages WHERE ts < ? AND held IS NULL AND (read_at IS NOT NULL OR to_agent='*' OR to_agent LIKE '@%')`)
      .run(old);
    this.db.prepare(`DELETE FROM message_reads WHERE message_id NOT IN (SELECT id FROM messages)`).run();
  }
  /** Media jobs left "running" by a hive process that died: fail them so callers stop waiting. */
  failStaleMedia(olderThanMs = 10 * 60_000) {
    this.db.prepare(`UPDATE media_jobs SET status='failed', error='the hive process running it stopped' WHERE status='running' AND ts < ?`).run(Date.now() - olderThanMs);
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
