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
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { HiveDb } from "./db.js";

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
      status: a.status,
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
      'Send a message to another agent (by name) or to "*" for everyone. Keep subject short. Use thread to continue a conversation. The recipient will see it as a work order on its next turn; you will not get a reply inline — check hive_inbox later.',
    inputSchema: {
      to: z.string().describe('Agent name or "*"'),
      subject: z.string().max(120),
      body: z.string(),
      thread: z.string().optional().describe("Thread id to reply into; omit to start a new one"),
    },
  },
  async ({ to, subject, body, thread }) => {
    if (to !== "*" && !db.getAgent(to)) {
      return text(`No agent named "${to}". Known: ${db.listAgents().map((a) => a.name).join(", ")}`);
    }
    const t = thread ?? `${me}-${Date.now().toString(36)}`;
    const id = db.send(me, to, subject, body, t);
    db.log(me, "send", { id, to, subject, thread: t });
    return text(`sent #${id} to ${to} (thread ${t})`);
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
    db.markRead(msgs.filter((m) => m.read_at == null).map((m) => m.id));
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

const transport = new StdioServerTransport();
await server.connect(transport);
