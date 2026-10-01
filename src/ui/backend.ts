#!/usr/bin/env node
/**
 * UI backend: owns the Hub and Scheduler for the pane UI and speaks NDJSON on
 * stdin/stdout to the Electron main process (see protocol.ts). Runs on system
 * Node so native modules (better-sqlite3) work without an Electron rebuild.
 *
 *   node backend.js --db .hive/hive.db [--cwd DIR]
 */
import * as ledger from "../core/ledger.js";
import { board } from "../hive/kanban.js";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import type * as schema from "@agentclientprotocol/sdk";
import { Hub } from "../core/hub.js";
import { probe } from "../core/doctor.js";
import { AGENTS } from "../core/agents.js";
import { POLICIES, type AgentSession, type SessionEvent } from "../core/session.js";
import { Scheduler, describeSchedule, formatDuration } from "../core/scheduler.js";
import { ROLES } from "../core/roles.js";
import { defaultDb } from "../core/home.js";
import { listWorktrees, mergeWorktree } from "../core/worktree.js";
import { buildReport } from "../core/report.js";
import { RECIPES, applyRecipe } from "../core/recipes.js";
import { findSkill, listSkills, prepareSkillValues, renderSkill, skillFromPrompt, skillPolicy, userSkillsDir } from "../core/skills.js";
import { runSkill, skillAgentName } from "../core/skill-run.js";
import { BB_PREFIX, BRANCHES } from "../core/watch.js";
import { setBudget, usageSummary } from "../core/budget.js";
import { applyVerdict, runVerdict } from "../core/verdict.js";
import { mcpServerList, parseMcpNames } from "../core/mcp-extra.js";
import type { AccountView, AgentView, BackendEvent, ElicitationAsk, GroupView, JobView, Layout, Methods, PermissionAsk, Request } from "./protocol.js";

// stdout is the protocol channel: keep stray logging off it.
const out = process.stdout.write.bind(process.stdout);
console.log = (...a: unknown[]) => console.error(...a);

const { values } = parseArgs({
  options: {
    db: { type: "string" },
    cwd: { type: "string", default: process.cwd() },
    poll: { type: "string", default: "1000" },
    // The Electron main process; stable across backend restarts.
    "owner-pid": { type: "string" },
  },
});
const dbPath = resolve(values.db ?? defaultDb(values.cwd!));
const layoutPath = join(dirname(dbPath), "ui.json");
const defaultCwd = resolve(values.cwd!);

function send(e: BackendEvent) {
  out(JSON.stringify(e) + "\n");
}

// One UI per hive: a second window on the same project would fight over agents.
const lockPath = join(dirname(dbPath), "ui.lock");
function pidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}
mkdirSync(dirname(lockPath), { recursive: true });
const ownerPid = Number(values["owner-pid"] ?? process.pid);
try {
  const other = Number(readFileSync(lockPath, "utf8"));
  if (other && other !== ownerPid && pidAlive(other)) {
    send({ event: "fatal", text: `Another hive window is already open on this project (pid ${other}). Close it first.` });
    process.exit(3);
  }
} catch {}
writeFileSync(lockPath, String(ownerPid));
process.on("exit", () => {
  try {
    if (readFileSync(lockPath, "utf8") === String(ownerPid)) rmSync(lockPath);
  } catch {}
});

// ---- pending interactive requests (permission / elicitation) ----

let seq = 0;
// Request ids must never repeat across backend restarts, or a stale card could answer a new request.
const bootId = `${process.pid.toString(36)}${Date.now().toString(36)}`;
const pendingPerm = new Map<string, { agent: string; resolve: (optionId: string) => void; reject: string; ask: PermissionAsk }>();
const pendingElicit = new Map<string, { agent: string; resolve: (r: schema.CreateElicitationResponse) => void; ask: ElicitationAsk }>();

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
  // a new or deleted file has no lines on that side, not one empty line
  const A = a ? a.split("\n") : [];
  const B = b ? b.split("\n") : [];
  let i = 0;
  while (i < A.length && i < B.length && A[i] === B[i]) i++;
  let j = 0;
  while (j < A.length - i && j < B.length - i && A[A.length - 1 - j] === B[B.length - 1 - j]) j++;
  const rows = [...A.slice(i, A.length - j).map((l) => `-${l}`), ...B.slice(i, B.length - j).map((l) => `+${l}`)];
  return rows.slice(0, 400).join("\n");
}

async function askPermission(req: schema.RequestPermissionRequest, agent: string, signal?: AbortSignal): Promise<string> {
  const reqId = `p-${bootId}-${++seq}`;
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
    pendingPerm.set(reqId, { agent, resolve: res, reject, ask });
    send({ event: "permission", ask });
    // The session gave up (cancel, ask timeout, close): withdraw the card.
    signal?.addEventListener("abort", () => {
      if (!pendingPerm.delete(reqId)) return;
      res(reject);
      send({ event: "permission_done", reqId, outcome: "withdrawn (cancelled or timed out)" });
    });
  });
}

async function elicit(req: schema.CreateElicitationRequest, agent: string, signal?: AbortSignal): Promise<schema.CreateElicitationResponse> {
  const reqId = `e-${bootId}-${++seq}`;
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
    pendingElicit.set(reqId, { agent, resolve: res, ask });
    send({ event: "elicitation", ask });
    signal?.addEventListener("abort", () => {
      if (!pendingElicit.delete(reqId)) return;
      res({ action: "cancel" });
      send({ event: "elicitation_done", reqId, outcome: "withdrawn (cancelled or timed out)" });
    });
  });
}

function dropPending(agent: string) {
  for (const [id, p] of pendingPerm)
    if (p.agent === agent) {
      p.resolve(p.reject);
      pendingPerm.delete(id);
      send({ event: "permission_done", reqId: id, outcome: "auto-rejected (agent stopped)" });
    }
  for (const [id, p] of pendingElicit)
    if (p.agent === agent) {
      p.resolve({ action: "cancel" });
      pendingElicit.delete(id);
      send({ event: "elicitation_done", reqId: id, outcome: "cancelled (agent stopped)" });
    }
}

// ---- hub + scheduler ----

let pushTimer: NodeJS.Timeout | undefined;
const schedulePush = () => {
  if (!pushTimer) pushTimer = setTimeout(pushAgents, 150);
};

const hub = new Hub({
  hiveDb: dbPath,
  // Same id after a backend restart, so this window reclaims its agents at once.
  id: `ui-${ownerPid}`,
  wakeSleeping: true,
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
              : e.type === "paused"
                ? `job ${e.job.id} paused (usage limit) until ${new Date(e.until).toLocaleTimeString()}`
                : e.fired
                ? `job ${e.job.id}: ${e.lines} changed lines → firing`
                : "";
    if (text) send({ event: "job", text, jobId: e.job.id, agent: e.job.agent });
    pushJobs();
  },
});

const policies = new Map<string, AgentView["policy"]>();
/**
 * Git branch per agent folder, refreshed in the background (at most every 30s)
 * so the 1s agent push never blocks streaming on a git process.
 */
const branches = new Map<string, { at: number; branch?: string; busy?: boolean }>();
function branchOf(cwd: string): string | undefined {
  const hit = branches.get(cwd);
  if (hit && (hit.busy || Date.now() - hit.at < 30_000)) return hit.branch;
  const entry = { at: Date.now(), branch: hit?.branch, busy: true };
  branches.set(cwd, entry);
  execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8", windowsHide: true }, (err, stdout) => {
    const branch = err ? undefined : stdout.trim() || undefined;
    const changed = branch !== entry.branch;
    branches.set(cwd, { at: Date.now(), branch });
    if (changed) schedulePush();
  });
  return entry.branch;
}

/** Timer work must never take the backend down (e.g. SQLITE_BUSY): log it and carry on. */
function logError(where: string, e: unknown) {
  console.error(`[hive backend] ${where}:`, e instanceof Error ? (e.stack ?? e.message) : e);
}

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
    auth: s.authStatus ? (s.authStatus.kind === "none" ? `not logged in${s.authStatus.detail ? ` · ${s.authStatus.detail}` : ""}` : (s.authStatus.label ?? s.authStatus.kind)) : undefined,
    jobs: hub.db.listJobs(false).filter((j) => j.agent === s.name).length,
    branch: branchOf(s.cwd),
    mcp: s.extraMcp,
  };
}

function pushAgents() {
  pushTimer = undefined;
  try {
    pushAgentsNow();
  } catch (e) {
    logError("pushAgents", e);
  }
}
function pushAgentsNow() {
  if (!hub.db.db.open) return;
  const others = hub.db
    .listAgents()
    // Verdict contenders/judges live in the verdict window, not the sidebar.
    .filter((a) => !hub.sessions.has(a.name) && a.kind && !a.role?.startsWith("verdict #"))
    .map((a) => {
      const status = hub.db.effectiveStatus(a);
      return {
        name: a.name,
        kind: a.kind,
        cwd: a.cwd,
        role: a.role || a.preset || "",
        policy: a.policy ?? undefined,
        status,
        note: a.status_note,
        unread: hub.db.unreadCount(a.name),
        where: status !== "asleep" && a.owner ? `another hive process (${a.owner.split("@")[0]})` : undefined,
      };
    });
  send({ event: "agents", agents: [...hub.sessions.values()].map(view), others, groups: groupViews(), mailScope: hub.db.mailScope(), heldTotal: hub.db.heldMessages().length, guardAllowAll: hub.db.guardAllowAll() });
}

function groupViews(): GroupView[] {
  const held = hub.db.heldMessages();
  return hub.db.groups().map((g) => {
    const st = hub.db.groupSettings(g.name);
    const n = held.filter((m) => m.via === g.name || m.to_agent === "@" + g.name).length;
    return { name: g.name, members: g.members, mode: st.mode, maxPerHour: st.max_per_hour, held: n };
  });
}
const groupView = (name: string) => groupViews().find((g) => g.name === name);

let lastOwnerUnread = -1;
function pushOwnerMail(force = false) {
  if (!hub.db.db.open) return;
  let unread: ReturnType<typeof hub.db.inbox>;
  try {
    unread = hub.db.inbox("owner", true, 500);
  } catch (e) {
    return logError("pushOwnerMail", e);
  }
  if (!force && unread.length === lastOwnerUnread) return;
  const grew = unread.length > lastOwnerUnread && lastOwnerUnread >= 0;
  lastOwnerUnread = unread.length;
  const last = unread.at(-1);
  send({ event: "owner_mail", unread: unread.length, latest: grew && last ? { from: last.from_agent, subject: last.subject } : undefined });
}

function pushJobs() {
  try {
    pushJobsNow();
  } catch (e) {
    logError("pushJobs", e);
  }
}
function pushJobsNow() {
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

const handlersExtra = {
  /** Everything a (re)loaded renderer needs: layout from disk, running agents, pending asks. */
  getState() {
    return {
      ready: readyEvent(),
      agents: [...hub.sessions.values()].map(view),
      permissions: [...pendingPerm.values()].map((p) => p.ask),
      elicitations: [...pendingElicit.values()].map((p) => p.ask),
      ownerUnread: hub.db.unreadCount("owner"),
    };
  },
};

// Sign-in status per agent type (spawns each adapter briefly, like `hive doctor`).
let accountsCache: { at: number; rows: AccountView[] } | undefined;
let accountsRunning: Promise<AccountView[]> | undefined;
async function checkAccounts(): Promise<AccountView[]> {
  const defs = Object.values(AGENTS).filter((d) => d.id !== "mock");
  const rows = await Promise.all(
    defs.map(async (d): Promise<AccountView> => {
      const r = await probe(d, 45_000, 12_000).catch((e) => ({ ok: false, installed: "ok" as const, error: String(e?.message ?? e) }) as any);
      const auth: string | undefined = r.auth;
      const signedIn =
        !r.ok ? false : !auth || /^(unknown|not reported)/.test(auth) ? null : /^(not logged in|key refused|can't reach)/.test(auth) ? false : true;
      const status = r.installed === "missing" ? "not installed" : !r.ok ? `doesn't start: ${String(r.error ?? "").slice(0, 160)}` : (auth ?? "installed (sign-in is checked when it starts)");
      return { id: d.id, label: d.label, api: !!d.api, signedIn, installed: r.installed, status, login: d.login, install: d.install, checkedAt: Date.now() };
    }),
  );
  accountsCache = { at: Date.now(), rows };
  return rows;
}
const handlers: { [K in keyof Methods]: (p: Parameters<Methods[K]>[0]) => Promise<ReturnType<Methods[K]>> | ReturnType<Methods[K]> } = {
  getState: () => handlersExtra.getState(),
  // ---- creator ----
  mcpServers: () => mcpServerList(),
  async addAgent(p) {
    const name = need(p.name, "name").trim();
    if (!/^[\w.-]{1,40}$/.test(name)) throw new Error(`name must be letters, digits, _ . - (got "${name}")`);
    if (!AGENTS[p.kind]) throw new Error(`unknown agent kind "${p.kind}"`);
    const r = p.preset ? ROLES[p.preset] : undefined;
    if (p.preset && !r) throw new Error(`unknown preset "${p.preset}"`);
    const policy = p.policy ?? r?.policy ?? "ask";
    if (!POLICIES.includes(policy)) throw new Error(`unknown policy "${policy}"`);
    const cwd = resolve(p.cwd || defaultCwd);
    if (!existsSync(cwd)) throw new Error(`folder does not exist: ${cwd}`);
    policies.set(name, policy);
    scheduler.adopt(name); // a pane owns it now: the scheduler must not close it when its jobs end
    const s = await hub.ensure({
      name,
      agent: p.kind,
      cwd,
      role: p.role || r?.role || "",
      policy,
      briefing: r?.briefing,
      worktree: p.worktree ?? r?.worktree ?? false,
      resume: p.resume ?? true,
      mcp: p.mcp ? parseMcpNames(p.mcp) : undefined,
    });
    if (p.startJob && r?.job) {
      const j = r.job;
      hub.db.addJob({
        agent: name,
        agent_kind: p.kind,
        cwd: s.cwd,
        prompt: j.prompt,
        kind: j.kind,
        policy,
        role: s.role,
        briefing: r.briefing,
        remaining: j.remaining ?? null,
        every_ms: j.every_ms ?? null,
        watch_path: j.kind === "watch" ? s.cwd : null,
        watch_min_lines: j.watch_min_lines ?? null,
      });
      pushJobs();
    }
    schedulePush();
    return view(s);
  },
  async worktrees() {
    // Every repo an open agent (or the launch folder) lives in.
    const dirs = new Set([defaultCwd, ...[...hub.sessions.values()].map((s) => s.cwd)]);
    const byRepo = new Map<string, Awaited<ReturnType<typeof listWorktrees>>>();
    for (const d of dirs) {
      try {
        const r = await listWorktrees(d);
        if (r.worktrees.length) byRepo.set(r.repo, r);
      } catch {
        // not a git repo
      }
    }
    return [...byRepo.values()];
  },
  async mergeWorktree({ name, repo }) {
    return mergeWorktree(repo, name);
  },
  async removeAgent({ name, forget, stopJobs }) {
    dropPending(name);
    // Jobs would otherwise bring the agent straight back, headless.
    if (stopJobs ?? true) for (const j of hub.db.listJobs(false)) if (j.agent === name) hub.db.endJob(j.id, "stopped");
    pushJobs();
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
    dropPending(name);
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
    if (!p.ask.options.some((o) => o.optionId === optionId)) throw new Error(`not an option of this request: ${optionId}`);
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
          watch_path: p.watchPath === BRANCHES || p.watchPath?.startsWith(BB_PREFIX) ? p.watchPath : resolve(s.cwd, p.watchPath || "."),
          watch_min_lines: p.minLines ?? (p.watchPath?.startsWith(BB_PREFIX) ? 1 : 50),
          every_ms: p.maxWaitMs ?? null,
          cooldown_ms: p.cooldownMs ?? null,
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
  async report({ sinceMs }) {
    const cwds = [defaultCwd, ...hub.db.listAgents().map((a) => a.cwd).filter(Boolean)];
    return buildReport(hub.db, Date.now() - sinceMs, cwds);
  },
  recipes() {
    return Object.values(RECIPES).map((r) => ({ id: r.id, label: r.label, description: r.description, agents: r.agents, next: r.next }));
  },
  applyRecipe({ id, kind, alt, prefix }) {
    const r = RECIPES[id];
    if (!r) throw new Error(`unknown recipe "${id}"`);
    if (!AGENTS[kind] || (alt && !AGENTS[alt])) throw new Error("unknown agent kind");
    if (prefix && !/^[\w.-]{0,20}$/.test(prefix)) throw new Error("prefix: letters, digits, _ . - only");
    const res = applyRecipe(hub.db, r, { cwd: defaultCwd, kind, alt, prefix });
    pushJobs();
    schedulePush();
    return { ...res, next: r.next };
  },
  skills() {
    return listSkills(defaultCwd).map((sk) => ({
      name: sk.name,
      description: sk.description,
      source: sk.source,
      agent: sk.agent,
      policy: skillPolicy(sk),
      output: sk.output,
      params: sk.params,
    }));
  },
  async runSkill({ name, params: raw, kind }) {
    const sk = findSkill(defaultCwd, name);
    const params = await prepareSkillValues(sk, raw); // YouTube link → transcript (errors show in the dialog)
    renderSkill(sk, params, defaultCwd); // validate now, so errors show in the dialog
    const k = kind || sk.agent || "claude";
    if (!AGENTS[k]) throw new Error(`unknown agent "${k}"`);
    const agent = skillAgentName(sk.name);
    policies.set(agent, skillPolicy(sk));
    void runSkill(hub, sk, params, { cwd: defaultCwd, kind: k })
      .then((r) => {
        if (r.saved) send({ event: "job", agent, jobId: 0, text: `saved to ${r.saved}` });
      })
      .catch((e) => send({ event: "error", text: `${name}: ${e?.message ?? e}` }));
    return { agent, kind: k, policy: skillPolicy(sk) };
  },
  groups() {
    return hub.db.groups();
  },
  usage() {
    return usageSummary(hub.db);
  },
  board({ done, project, q }) {
    const b = board();
    const all = b.list({ done: true });
    return { cards: b.list({ done, project, q }), counts: b.counts(), projects: [...new Set(all.map((c) => c.project).filter(Boolean))].sort() };
  },
  cardAdd(p) {
    return board().add({ ...p, source: "owner" });
  },
  cardMove({ id, col, before }) {
    return board().move(id, col, before);
  },
  cardUpdate({ id, ...p }) {
    return board().update(id, p);
  },
  cardRemove({ id }) {
    return board().remove(id);
  },
  stats({ by, filter }) {
    return { ...ledger.stats(by, filter ?? {}), facets: ledger.facets(filter ?? {}) };
  },
  startVerdict({ prompt, kinds, judge, judgeModel, mode, policy }) {
    // Runs in the background; progress arrives as "verdict" events. Resolves once it has an id.
    return new Promise<{ id: number }>((res, rej) => {
      let started = false;
      void runVerdict(hub, {
        prompt,
        kinds,
        judge,
        judgeModel: judgeModel?.trim() || undefined,
        mode,
        policy,
        cwd: defaultCwd,
        onProgress: (state) => {
          if (!started) {
            started = true;
            res({ id: state.id });
          }
          send({ event: "verdict", state });
          schedulePush();
        },
      }).catch((e) => {
        if (!started) rej(e);
        else send({ event: "error", text: `verdict: ${e?.message ?? e}` });
      });
    });
  },
  applyVerdict({ id, label }) {
    void applyVerdict(hub, id, { label, onProgress: (state) => send({ event: "verdict", state }) }).catch((e) => send({ event: "error", text: `apply verdict: ${e?.message ?? e}` }));
  },
  verdicts() {
    return hub.db.listVerdicts(20);
  },
  async accounts({ refresh }) {
    if (!refresh && accountsCache && Date.now() - accountsCache.at < 120_000) return accountsCache.rows;
    accountsRunning ??= checkAccounts().finally(() => (accountsRunning = undefined));
    return accountsRunning;
  },
  link({ members, name, mode, maxPerHour, includeOwner }) {
    const ms = [...new Set(members)].filter(Boolean);
    if (ms.length < 2) throw new Error("link at least two agents");
    for (const m of ms) if (!hub.db.getAgent(m)) throw new Error(`no agent "${m}"`);
    const g = (name?.trim() || ms.join("-")).slice(0, 40);
    if (!/^[\w.-]{1,40}$/.test(g)) throw new Error("group name: letters, digits, _ . - (max 40)");
    hub.db.addToGroup(g, includeOwner === false ? ms : [...ms, "owner"]);
    if (mode || maxPerHour !== undefined) hub.db.setGroupSettings(g, { ...(mode ? { mode } : {}), ...(maxPerHour !== undefined ? { max_per_hour: maxPerHour } : {}) });
    schedulePush();
    return groupView(g)!;
  },
  groupChat({ name }) {
    const group = groupView(name);
    if (!group) throw new Error(`no group "${name}"`);
    return { group, messages: hub.db.groupMessages(name, 300) };
  },
  setGroup({ name, mode, maxPerHour, remove, add, delete: del }) {
    if (!hub.db.groupMembers(name).length) throw new Error(`no group "${name}"`);
    if (del) hub.db.deleteGroup(name); // refuses while messages are waiting for review
    else {
      if (mode || maxPerHour !== undefined) hub.db.setGroupSettings(name, { ...(mode ? { mode } : {}), ...(maxPerHour !== undefined ? { max_per_hour: maxPerHour } : {}) });
      if (remove) hub.db.removeFromGroup(name, remove);
      if (add) {
        if (add !== "owner" && !hub.db.getAgent(add)) throw new Error(`no agent "${add}"`);
        hub.db.addToGroup(name, [add]);
      }
    }
    schedulePush();
    return groupView(name) ?? null;
  },
  releaseMail({ id, body }) {
    if (!hub.db.releaseMessage(id, body?.trim() ? body : undefined)) throw new Error(`#${id} isn't waiting any more`);
    schedulePush();
  },
  dropMail({ id }) {
    if (!hub.db.dropMessage(id)) throw new Error(`#${id} isn't waiting any more`);
    schedulePush();
  },
  setGuard({ on }) {
    hub.db.setGuardAllowAll(on);
    schedulePush();
  },
  heldMail() {
    return hub.db.heldMessages();
  },
  setScope({ scope }) {
    hub.db.setMailScope(scope);
    schedulePush();
  },
  saveSkill({ name, description, body, overwrite }) {
    const { text, params } = skillFromPrompt(need(name, "name").trim(), description ?? "", need(body, "prompt"));
    const dir = userSkillsDir();
    const path = join(dir, `${name.trim()}.md`);
    if (existsSync(path) && !overwrite) throw new Error(`a skill named ${name} already exists (${path})`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, text);
    return { path, params };
  },
  setBudget({ key, value }) {
    setBudget(hub.db, need(key, "key"), String(value ?? ""));
    return usageSummary(hub.db);
  },
  hiveData() {
    return {
      blackboard: hub.db.bbList(""),
      messages: hub.db.messagesSince(0, 200),
      agents: [...hub.db.listAgents().map((a) => a.name), ...hub.db.groups().map((g) => "@" + g.name)],
    };
  },
  sendMail({ to, subject, body }) {
    const text = need(body, "message").trim();
    if (to.startsWith("@") ? !hub.db.groupMembers(to.slice(1)).length : to !== "*" && !hub.db.getAgent(to)) throw new Error(`no agent or group "${to}"`);
    return hub.db.send("owner", to, subject?.trim() || text.split("\n")[0].slice(0, 80), text);
  },
  jobRuns({ id }) {
    return hub.db.jobRuns(id, 100).map((r) => {
      let tokens: number | undefined;
      try {
        tokens = r.usage ? JSON.parse(r.usage).totalTokens : undefined;
      } catch {}
      return { iteration: r.iteration, started: r.started, ended: r.ended, stop_reason: r.stop_reason, error: r.error, summary: r.summary, tokens };
    });
  },
  bbDelete({ key }) {
    hub.db.bbDelete(key);
  },
  markOwnerRead() {
    hub.db.markRead(hub.db.inbox("owner", true, 500).map((m) => m.id), "owner");
    pushOwnerMail(true);
  },
};

function readyEvent(): Extract<BackendEvent, { event: "ready" }> {
  return {
    event: "ready",
    // the mock agent is for tests (HIVE_SHOW_MOCK=1); users never pick it
    kinds: Object.values(AGENTS).filter((a) => a.id !== "mock" || process.env.HIVE_SHOW_MOCK === "1").map((a) => ({
      id: a.id,
      label: a.api ? `${a.label} · API` : a.label,
      api: a.api,
      missing: a.needs && !process.env[a.needs] ? a.needs : undefined,
      install: a.install,
    })),
    presets: Object.values(ROLES).map((r) => ({
      id: r.id,
      label: r.label,
      role: r.role,
      policy: r.policy,
      worktree: r.worktree,
      job: r.job
        ? r.job.kind === "interval"
          ? `every ${formatDuration(r.job.every_ms ?? 0)}`
          : r.job.kind === "watch"
            ? `when ≥${r.job.watch_min_lines ?? 50} lines change`
            : r.job.kind === "loop"
              ? `loop ${r.job.remaining ?? ""}×`
              : r.job.kind
        : undefined,
    })),
    cwd: defaultCwd,
    layout: loadLayout(), // fresh from disk, so a renderer reload sees the current layout
    db: dbPath,
  };
}

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
// One failed callback (a busy database, a dying agent process) must not end every session in the window.
process.on("uncaughtException", (e: any) => {
  logError("uncaught", e);
  if (e?.code === "EPIPE") void shutdown(); // the window is gone
});
process.on("unhandledRejection", (e) => logError("unhandled rejection", e));

hub.run();
scheduler.start();
setInterval(pushAgents, 1000).unref();
setInterval(pushJobs, 5000).unref();
setInterval(() => pushOwnerMail(), 2000).unref();
send(readyEvent());
pushJobs();
