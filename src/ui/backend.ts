#!/usr/bin/env node
/**
 * UI backend: owns the Hub and Scheduler for the pane UI and speaks NDJSON on
 * stdin/stdout to the Electron main process (see protocol.ts). Runs on system
 * Node so native modules (better-sqlite3) work without an Electron rebuild.
 *
 *   node backend.js --db .hive/hive.db [--cwd DIR]
 */
import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import type * as schema from "@agentclientprotocol/sdk";
import { Hub } from "../core/hub.js";
import { AGENTS } from "../core/agents.js";
import { POLICIES, type AgentSession, type SessionEvent } from "../core/session.js";
import { Scheduler, describeSchedule } from "../core/scheduler.js";
import type { AgentView, BackendEvent, ElicitationAsk, JobView, Layout, Methods, PermissionAsk, Request } from "./protocol.js";

// stdout is the protocol channel: keep stray logging off it.
const out = process.stdout.write.bind(process.stdout);
console.log = (...a: unknown[]) => console.error(...a);

const { values } = parseArgs({
  options: {
    db: { type: "string", default: ".hive/hive.db" },
    cwd: { type: "string", default: process.cwd() },
    poll: { type: "string", default: "1000" },
  },
});
const dbPath = resolve(values.db!);
const layoutPath = join(dirname(dbPath), "ui.json");
const defaultCwd = resolve(values.cwd!);

function send(e: BackendEvent) {
  out(JSON.stringify(e) + "\n");
}

// ---- pending interactive requests (permission / elicitation) ----

let seq = 0;
const pendingPerm = new Map<string, { agent: string; resolve: (optionId: string) => void; reject: string }>();
const pendingElicit = new Map<string, { agent: string; resolve: (r: schema.CreateElicitationResponse) => void }>();

function toolDetail(req: schema.RequestPermissionRequest): string | undefined {
  const tc = req.toolCall as any;
  for (const c of tc.content ?? []) {
    if (c.type === "diff") return `--- ${c.path}\n${diffLines(c.oldText ?? "", c.newText ?? "")}`;
    if (c.type === "content" && c.content?.type === "text") return String(c.content.text).slice(0, 4000);
  }
  if (tc.rawInput) return JSON.stringify(tc.rawInput, null, 2).slice(0, 4000);
  return undefined;
}

/** Tiny line diff for previews (prefix-based; the renderer does the same for tool cards). */
function diffLines(a: string, b: string): string {
  const A = a.split("\n");
  const B = b.split("\n");
  let i = 0;
  while (i < A.length && i < B.length && A[i] === B[i]) i++;
  let j = 0;
  while (j < A.length - i && j < B.length - i && A[A.length - 1 - j] === B[B.length - 1 - j]) j++;
  const rows = [...A.slice(i, A.length - j).map((l) => `-${l}`), ...B.slice(i, B.length - j).map((l) => `+${l}`)];
  return rows.slice(0, 400).join("\n");
}

async function askPermission(req: schema.RequestPermissionRequest, agent: string): Promise<string> {
  const reqId = `p${++seq}`;
  const reject = req.options.find((o) => o.kind.startsWith("reject"))?.optionId ?? req.options[0].optionId;
  const ask: PermissionAsk = {
    reqId,
    agent,
    title: req.toolCall.title ?? "tool",
    kind: (req.toolCall as any).kind ?? undefined,
    options: req.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
    detail: toolDetail(req),
  };
  return new Promise((res) => {
    pendingPerm.set(reqId, { agent, resolve: res, reject });
    send({ event: "permission", ask });
  });
}

async function elicit(req: schema.CreateElicitationRequest, agent: string): Promise<schema.CreateElicitationResponse> {
  const reqId = `e${++seq}`;
  const r = req as any;
  const props = (r.requestedSchema?.properties ?? {}) as Record<string, any>;
  const ask: ElicitationAsk = {
    reqId,
    agent,
    message: req.message,
    mode: req.mode,
    url: r.url,
    fields: Object.entries(props).map(([key, p]) => ({
      key,
      title: p.title ?? key,
      type: p.type ?? "string",
      description: p.description,
      choices: p.enum ?? p.oneOf?.map((o: any) => o.const) ?? p.items?.enum,
      required: !!r.requestedSchema?.required?.includes(key),
    })),
  };
  return new Promise((res) => {
    pendingElicit.set(reqId, { agent, resolve: res });
    send({ event: "elicitation", ask });
  });
}

function dropPending(agent: string) {
  for (const [id, p] of pendingPerm)
    if (p.agent === agent) {
      p.resolve(p.reject);
      pendingPerm.delete(id);
      send({ event: "permission_done", reqId: id });
    }
  for (const [id, p] of pendingElicit)
    if (p.agent === agent) {
      p.resolve({ action: "cancel" });
      pendingElicit.delete(id);
      send({ event: "elicitation_done", reqId: id });
    }
}

// ---- hub + scheduler ----

let pushTimer: NodeJS.Timeout | undefined;
const schedulePush = () => {
  if (!pushTimer) pushTimer = setTimeout(pushAgents, 150);
};

const hub = new Hub({
  hiveDb: dbPath,
  pollMs: Number(values.poll),
  defaults: { askPermission, elicit },
  onEvent: (agent: string, e: SessionEvent) => {
    send({ event: "agent", agent, e });
    if (e.type === "status" || e.type === "context" || e.type === "config" || e.type === "exit" || e.type === "auth" || e.type === "session")
      schedulePush();
    if (e.type === "exit") dropPending(agent);
  },
});
const scheduler = new Scheduler({
  hub,
  closeIdleAgents: true,
  onJob: (e) => {
    const text =
      e.type === "run_start"
        ? `▶ job ${e.job.id} run ${e.iteration}`
        : e.type === "run_end"
          ? `■ job ${e.job.id} run ${e.iteration}: ${e.result.stopReason}`
          : e.type === "job_end"
            ? `job ${e.job.id} ended: ${e.reason}`
            : e.type === "error"
              ? `job ${e.job.id}: ${e.error}`
              : e.fired
                ? `job ${e.job.id}: ${e.lines} changed lines → firing`
                : "";
    if (text) send({ event: "job", text, jobId: e.job.id, agent: e.job.agent });
    pushJobs();
  },
});

const policies = new Map<string, AgentView["policy"]>();

function view(s: AgentSession): AgentView {
  const row = hub.db.getAgent(s.name);
  const status = s.isClosed ? "asleep" : ((row?.status ?? "idle") as AgentView["status"]);
  return {
    name: s.name,
    kind: s.def.id,
    label: s.def.label,
    cwd: s.cwd,
    role: s.role,
    policy: policies.get(s.name) ?? "ask",
    status: s.busyNow && status === "idle" ? "working" : status,
    note: row?.status_note ?? "",
    idleMs: s.idleMs,
    queued: s.queued,
    unread: hub.db.unreadCount(s.name),
    sessionId: s.sessionId,
    ctx: s.context,
    config: s.configOptions.map((o: any) => ({
      id: o.id,
      name: o.name,
      category: o.category,
      type: o.type,
      currentValue: o.currentValue,
      options: o.options?.flatMap((g: any) => (g.options ? g.options : [g])).map((x: any) => ({ value: x.value, name: x.name })),
    })),
    auth: s.authStatus ? (s.authStatus.kind === "none" ? "not logged in" : (s.authStatus.label ?? s.authStatus.kind)) : undefined,
    jobs: hub.db.listJobs(false).filter((j) => j.agent === s.name).length,
  };
}

function pushAgents() {
  pushTimer = undefined;
  if (!hub.db.db.open) return;
  send({ event: "agents", agents: [...hub.sessions.values()].map(view) });
}

function pushJobs() {
  if (!hub.db.db.open) return;
  const jobs: JobView[] = hub.db.listJobs(true).slice(-50).map((j) => ({
    id: j.id,
    kind: j.kind,
    agent: j.agent,
    agentKind: j.agent_kind,
    prompt: j.prompt,
    schedule: describeSchedule(j),
    runs: j.runs,
    state: j.enabled ? (j.owner ? "active" : "queued") : (j.ended_reason ?? "ended"),
    lastError: j.last_error,
    nextRun: j.enabled ? j.next_run : undefined,
  }));
  send({ event: "jobs", jobs });
}

function loadLayout(): Layout {
  const def: Layout = { panes: [], columns: 2, hoverFocus: true, sidebar: true, maximized: null };
  try {
    if (existsSync(layoutPath)) return { ...def, ...JSON.parse(readFileSync(layoutPath, "utf8")) };
  } catch {}
  return def;
}

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined || v === null || v === "") throw new Error(`missing ${what}`);
  return v;
}

function session(name: string): AgentSession {
  const s = hub.sessions.get(name);
  if (!s) throw new Error(`no running agent "${name}"`);
  return s;
}

const handlers: { [K in keyof Methods]: (p: Parameters<Methods[K]>[0]) => Promise<ReturnType<Methods[K]>> | ReturnType<Methods[K]> } = {
  async addAgent(p) {
    const name = need(p.name, "name").trim();
    if (!/^[\w.-]{1,40}$/.test(name)) throw new Error(`name must be letters, digits, _ . - (got "${name}")`);
    if (!AGENTS[p.kind]) throw new Error(`unknown agent kind "${p.kind}"`);
    const policy = p.policy ?? "ask";
    if (!POLICIES.includes(policy)) throw new Error(`unknown policy "${policy}"`);
    const cwd = resolve(p.cwd || defaultCwd);
    if (!existsSync(cwd)) throw new Error(`folder does not exist: ${cwd}`);
    policies.set(name, policy);
    const s = await hub.ensure({ name, agent: p.kind, cwd, role: p.role ?? "", policy, resume: p.resume ?? true });
    schedulePush();
    return view(s);
  },
  async removeAgent({ name, forget }) {
    dropPending(name);
    await hub.remove(name, forget ?? false);
    policies.delete(name);
    schedulePush();
  },
  prompt({ name, text }) {
    const s = session(name);
    void s.prompt(need(text, "text")).catch((e) => send({ event: "error", text: `${name}: ${e?.message ?? e}` }));
    schedulePush();
  },
  broadcast({ names, text }) {
    for (const n of names) handlers.prompt({ name: n, text });
  },
  async cancel({ name }) {
    await session(name).cancel();
  },
  async newSession({ name }) {
    await session(name).newSession();
    schedulePush();
  },
  async setConfig({ name, configId, value }) {
    await session(name).setConfigOption(configId, value);
    schedulePush();
  },
  answerPermission({ reqId, optionId }) {
    const p = pendingPerm.get(reqId);
    if (!p) return;
    pendingPerm.delete(reqId);
    p.resolve(optionId);
    send({ event: "permission_done", reqId });
  },
  answerElicitation({ reqId, action, content }) {
    const p = pendingElicit.get(reqId);
    if (!p) return;
    pendingElicit.delete(reqId);
    p.resolve(action === "accept" ? { action, content: (content ?? {}) as any } : { action });
    send({ event: "elicitation_done", reqId });
  },
  saveLayout(l) {
    mkdirSync(dirname(layoutPath), { recursive: true });
    writeFileSync(layoutPath, JSON.stringify(l, null, 2));
  },
  history({ name, limit }) {
    return hub.db
      .agentEvents(name, ["prompt", "reply", "turn_end", "tool_call", "permission", "session"], limit ?? 200)
      .map((e) => ({ ts: e.ts, type: e.type, data: JSON.parse(e.data) }));
  },
  addJob(p) {
    const s = session(p.agent);
    const policy = policies.get(p.agent) ?? "allow-reads";
    const base = { agent: s.name, agent_kind: s.def.id, cwd: s.cwd, prompt: need(p.prompt, "prompt"), policy, role: s.role };
    let id: number;
    switch (p.kind) {
      case "loop":
        if (!p.times && !p.forMs) throw new Error("loop needs times and/or a duration");
        id = hub.db.addJob({ ...base, kind: "loop", remaining: p.times ?? null, until_ts: p.forMs ? Date.now() + p.forMs : null });
        break;
      case "interval":
        id = hub.db.addJob({ ...base, kind: "interval", every_ms: need(p.everyMs, "interval") });
        break;
      case "watch":
        id = hub.db.addJob({
          ...base,
          kind: "watch",
          watch_path: resolve(s.cwd, p.watchPath || "."),
          watch_min_lines: p.minLines ?? 50,
        });
        break;
      case "once":
        id = hub.db.addJob({ ...base, kind: "once" });
        break;
      default:
        throw new Error(`unknown job kind ${(p as any).kind}`);
    }
    pushJobs();
    return id;
  },
  stopJob({ id }) {
    hub.db.endJob(id, "stopped");
    pushJobs();
  },
};

// ---- main loop ----

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let req: Request;
  try {
    req = JSON.parse(line);
  } catch {
    return send({ event: "error", text: `bad request: ${line.slice(0, 100)}` });
  }
  const h = (handlers as any)[req.method];
  try {
    if (!h) throw new Error(`unknown method ${req.method}`);
    const result = await h(req.params ?? {});
    out(JSON.stringify({ id: req.id, result: result ?? null }) + "\n");
  } catch (e: any) {
    out(JSON.stringify({ id: req.id, error: String(e?.message ?? e) }) + "\n");
  }
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await scheduler.stop();
  await hub.close();
  process.exit(0);
}
rl.on("close", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

hub.run();
scheduler.start();
setInterval(pushAgents, 1000).unref();
setInterval(pushJobs, 5000).unref();
send({
  event: "ready",
  kinds: Object.values(AGENTS).map((a) => ({ id: a.id, label: a.label })),
  cwd: defaultCwd,
  layout: loadLayout(),
  db: dbPath,
});
pushJobs();
