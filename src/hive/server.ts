#!/usr/bin/env node
/**
 * Hive MCP server (stdio). One instance per agent session, launched by the
 * agent itself because the hub passes it in `session/new.mcpServers`.
 *
 * Identity comes from env: HIVE_DB (sqlite path) and HIVE_AGENT (this agent's
 * name). The agent never chooses its own name, so it can't impersonate.
 *
 * Tools:
 *   hive_agents      list who is in the hive and what they're doing
 *   hive_send        send a message to one agent or "*" for everyone
 *   hive_inbox       read (and mark read) my unread messages
 *   hive_thread      read a whole thread
 *   hive_bb_get/set/list   shared blackboard (project facts, decisions, task claims)
 *   hive_status      publish my own status line (shown in the UI)
 *   hive_bb_delete   remove a blackboard key (retire an idea, release a claim)
 *   hive_diff        another agent's changes (its hive/<name> branch vs base, plus uncommitted)
 *   hive_log         commits on an agent's branch that aren't on the base branch
 *
 * hive_diff / hive_log run git read-only inside this server, so reviewers
 * with an allow-reads policy can read diffs without a shell permission prompt.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { HiveDb } from "./db.js";
import { baseBranch, git, repoRoot } from "../core/worktree.js";

const dbPath = process.env.HIVE_DB;
const me = process.env.HIVE_AGENT;
if (!dbPath || !me) {
  console.error("hive-mcp: HIVE_DB and HIVE_AGENT must be set");
  process.exit(2);
}
const db = new HiveDb(dbPath);

const server = new McpServer({ name: "hive", version: "0.0.1" });

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

server.registerTool(
  "hive_agents",
  {
    description:
      "List agents in the hive: name, kind (claude/codex/qwen/...), role, cwd, status and last status note. Use this to decide who to message.",
    inputSchema: {},
  },
  async () => {
    const rows = db.listAgents().map((a) => ({
      name: a.name,
      kind: a.kind,
      role: a.role,
      cwd: a.cwd,
      status: db.effectiveStatus(a),
      note: a.status_note,
      me: a.name === me,
      unread: db.unreadCount(a.name),
    }));
    return text(JSON.stringify(rows, null, 2));
  },
);

server.registerTool(
  "hive_send",
  {
    description:
      'Send a message to another agent (by name), to "*" for everyone, or to "owner" for the human (use sparingly: decisions you need, finished work, blockers). Keep subject short. Use thread to continue a conversation. The recipient will see it as a work order on its next turn; you will not get a reply inline — check hive_inbox later.',
    inputSchema: {
      to: z.string().describe('Agent name or "*"'),
      subject: z.string().max(120),
      body: z.string(),
      thread: z.string().optional().describe("Thread id to reply into; omit to start a new one"),
    },
  },
  async ({ to, subject, body, thread }) => {
    if (to !== "*" && to !== "owner" && !db.getAgent(to)) {
      return text(`No agent named "${to}". Known: owner (the human), ${db.listAgents().map((a) => a.name).join(", ")}`);
    }
    const t = thread ?? `${me}-${Date.now().toString(36)}`;
    // Stop runaway back-and-forth between agents.
    const max = Number(process.env.HIVE_MAX_THREAD ?? 30);
    if (thread && db.threadLength(thread) >= max)
      return text(
        `Thread ${thread} already has ${max} messages; not sent. Stop replying in this thread. If something is unresolved, write a summary to the blackboard (hive_bb_set "owner/<topic>") for the human.`,
      );
    const id = db.send(me, to, subject, body, t);
    db.log(me, "send", { id, to, subject, thread: t });
    const target = to === "*" || to === "owner" ? undefined : db.getAgent(to);
    const asleep = target && (target.status === "asleep" || target.status === "error");
    return text(`sent #${id} to ${to} (thread ${t})${asleep ? ` — ${to} is ${target!.status}; it will get this when it next runs` : ""}`);
  },
);

server.registerTool(
  "hive_inbox",
  {
    description:
      "Read my unread messages and mark them read. Returns [] if nothing new. Call at the start of a turn and before declaring work finished.",
    inputSchema: {
      include_read: z.boolean().optional().describe("Also return recent already-read messages"),
    },
  },
  async ({ include_read }) => {
    const msgs = db.inbox(me, !include_read);
    db.markRead(msgs.filter((m) => m.read_at == null).map((m) => m.id), me);
    const out = msgs.map((m) => ({
      id: m.id,
      at: new Date(m.ts).toISOString(),
      from: m.from_agent,
      to: m.to_agent,
      subject: m.subject,
      body: m.body,
      thread: m.thread,
    }));
    return text(JSON.stringify(out, null, 2));
  },
);

server.registerTool(
  "hive_thread",
  {
    description: "Read all messages in a thread, oldest first.",
    inputSchema: { thread: z.string() },
  },
  async ({ thread }) => {
    const msgs = db.thread(thread).map((m) => ({
      id: m.id,
      from: m.from_agent,
      to: m.to_agent,
      subject: m.subject,
      body: m.body,
    }));
    return text(JSON.stringify(msgs, null, 2));
  },
);

server.registerTool(
  "hive_bb_set",
  {
    description:
      "Write a key on the shared blackboard. Use it for durable, project-wide facts every agent should see: decisions, conventions, claimed tasks ('claim/<task>' = your name), current build status. Overwrites.",
    inputSchema: { key: z.string(), value: z.string() },
  },
  async ({ key, value }) => {
    db.bbSet(key, value, me);
    db.log(me, "bb_set", { key });
    return text(`ok ${key}`);
  },
);

server.registerTool(
  "hive_bb_get",
  { description: "Read one blackboard key.", inputSchema: { key: z.string() } },
  async ({ key }) => {
    const e = db.bbGet(key);
    return text(e ? JSON.stringify(e, null, 2) : "null");
  },
);

server.registerTool(
  "hive_bb_list",
  {
    description: "List blackboard entries, optionally by key prefix (e.g. 'claim/').",
    inputSchema: { prefix: z.string().optional() },
  },
  async ({ prefix }) => text(JSON.stringify(db.bbList(prefix ?? ""), null, 2)),
);

server.registerTool(
  "hive_status",
  {
    description:
      "Publish a one-line status for the UI and other agents, e.g. 'refactoring auth module' or 'blocked: need API key'.",
    inputSchema: {
      status: z.enum(["idle", "working", "waiting"]).optional(),
      note: z.string().max(200),
    },
  },
  async ({ status, note }) => {
    db.setStatus(me, status ?? "working", note);
    return text("ok");
  },
);

server.registerTool(
  "hive_bb_delete",
  { description: "Delete a blackboard key (retire an idea, release a claim/<task>).", inputSchema: { key: z.string() } },
  async ({ key }) => {
    db.bbDelete(key);
    db.log(me, "bb_delete", { key });
    return text(`deleted ${key}`);
  },
);

/**
 * Refs and paths come from the agent: never let them be read as git options
 * (e.g. branch "--output=/some/file"). Refs must look like refs; paths go after "--".
 */
function safeRef(r: string, what: string): string {
  if (!/^[\w./@{}~^-]+$/.test(r) || r.startsWith("-") || r.includes("..")) throw new Error(`invalid ${what}: ${JSON.stringify(r)}`);
  return r;
}
function safePaths(ps?: string[]): string[] {
  if (!ps?.length) return [];
  for (const p of ps) if (p.startsWith("-") || p.includes("\0")) throw new Error(`invalid path: ${JSON.stringify(p)}`);
  return ["--", ...ps];
}

/** Resolve an agent's folder and branch (defaults: me). */
async function target(agent?: string, branch?: string) {
  const self = db.getAgent(me!);
  const who = agent ? db.getAgent(agent) : self;
  if (agent && !who) throw new Error(`No agent named "${agent}". Known: ${db.listAgents().map((a) => a.name).join(", ")}`);
  const cwd = who?.cwd || self?.cwd || process.cwd();
  const repo = await repoRoot(cwd);
  const br = safeRef(branch ?? (await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim(), "branch");
  return { cwd, repo, branch: br };
}

const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `\n… (truncated, ${s.length - n} more bytes; narrow with paths)` : s);

server.registerTool(
  "hive_diff",
  {
    description:
      "Show another agent's work: the diff of its branch (e.g. hive/<name>) against the base branch, plus its uncommitted changes. Read-only. Use this to review a coder's work when it tells you it's ready.",
    inputSchema: {
      agent: z.string().optional().describe("Agent whose work to show (default: me)"),
      branch: z.string().optional().describe("Branch to diff instead of the agent's current branch"),
      base: z.string().optional().describe("Base branch (default: the main checkout's branch)"),
      paths: z.array(z.string()).optional().describe("Limit to these paths"),
      stat_only: z.boolean().optional(),
      max_bytes: z.number().optional().describe("Cap on patch size (default 60000)"),
    },
  },
  async ({ agent, branch, base, paths, stat_only, max_bytes }) => {
    try {
      const t = await target(agent, branch);
      const b = safeRef(base ?? (await baseBranch(t.repo)), "base");
      const range = `${b}...${t.branch}`;
      const ps = safePaths(paths);
      const stat = await git(["diff", "--stat", "--end-of-options", range, ...ps], t.repo);
      const log = await git(["log", "--oneline", "-n", "30", "--end-of-options", `${b}..${t.branch}`], t.repo).catch(() => "");
      const dirty = await git(["status", "--porcelain", ...ps], t.cwd).catch(() => "");
      let out = `# ${t.branch} vs ${b}\n\n## commits\n${log || "(none)"}\n\n## diffstat\n${stat || "(no committed changes)"}\n`;
      if (dirty.trim()) out += `\n## uncommitted in ${t.cwd}\n${dirty}`;
      if (!stat_only) {
        const n = max_bytes ?? 60_000;
        const patch = await git(["diff", "--end-of-options", range, ...ps], t.repo);
        out += `\n## patch\n${cap(patch, n)}`;
        if (dirty.trim()) out += `\n## uncommitted patch\n${cap(await git(["diff", "HEAD", ...ps], t.cwd).catch(() => ""), Math.max(5000, n / 3))}`;
      }
      return text(out);
    } catch (e: any) {
      return text(`hive_diff failed: ${e?.message ?? e}`);
    }
  },
);

server.registerTool(
  "hive_log",
  {
    description: "Commits on an agent's branch that are not on the base branch (newest first). Read-only.",
    inputSchema: {
      agent: z.string().optional(),
      branch: z.string().optional(),
      base: z.string().optional(),
      n: z.number().optional().describe("Max commits (default 30)"),
    },
  },
  async ({ agent, branch, base, n }) => {
    try {
      const t = await target(agent, branch);
      const b = safeRef(base ?? (await baseBranch(t.repo)), "base");
      const out = await git(["log", `--max-count=${Math.max(1, Math.min(500, Math.floor(n ?? 30)))}`, "--format=%h %ad %s", "--date=short", "--end-of-options", `${b}..${t.branch}`], t.repo);
      return text(out || `(no commits on ${t.branch} beyond ${b})`);
    } catch (e: any) {
      return text(`hive_log failed: ${e?.message ?? e}`);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
