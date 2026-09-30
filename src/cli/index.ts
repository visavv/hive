#!/usr/bin/env node
/**
 * hive CLI — drives the hub from a terminal until the pane UI exists.
 *
 * Agents
 *   hive run <agent> [opts] "prompt"          one prompt, wait for replies to settle, exit
 *   hive chat <agent> [opts]                  interactive (resumes the last session; --fresh for a new one)
 *   hive agents                               list hive members
 *   hive doctor [agent...] [--quick]          installed? speaks ACP? logged in?
 *
 * Jobs (phase 2 scheduler)
 *   hive loop <agent> --times 5 "prompt"      back-to-back fresh sessions with a shared notes file
 *   hive loop <agent> --for 8h "prompt"       … until the time is up (--hours 8 also works)
 *   hive every <agent> 10m "prompt"           on an interval
 *   hive watch <agent> <path> [--min-lines 50] [--max-wait 30m] "prompt"
  hive watch <agent> --branches "prompt"  fire on new commits on agents' hive/* branches
  hive watch <agent> --bb ideas/raw/ "prompt"   fire when agents post blackboard entries under a prefix
      watch options: --min-lines N (or min new entries)  --max-wait 30m (any change after T)  --cooldown 10m (at most every T)
  hive groups · hive group create|add|rm|delete <name> [members…]   mail "@name" reaches all members
  hive recipe list · hive recipe apply <id> [--agent claude] [--alt codex]   a ready-made team (review-loop, solid-code, idea-pipeline, studio)
  hive skill list · hive skill run <name> k=v … · hive skill new <name> [--describe "…"]   reusable prompts with parameters
 *   hive once <agent> [--in 20m | --at 2026-10-01T09:00] "prompt"
 *   hive jobs [--all]                         list jobs
 *   hive job stop|start|runs|rm <id>
 *   hive serve                                run every job + mail delivery until Ctrl-C
 *   hive start <agent> --as security|scout|bughunter   a preset's default job
 *
 * Worktrees (one per coding agent)
 *   hive chat claude --worktree               agent works in .hive/worktrees/<name> on branch hive/<name>
 *   hive worktrees                            branches, ahead/behind, diffstat, dirty files
 *   hive merge <name>                         merge hive/<name> into the main checkout (--no-ff)
 *   hive worktree rm <name> [--force]
 *
 *   Job commands run in the foreground until the job ends (Ctrl-C stops it);
 *   --detach only queues it for `hive serve`.
 *
 * Common options: --name N --cwd DIR --role R --policy ask|allow-reads|allow-all|reject-all
 *                 --as coder|reviewer|security|scout|bughunter --worktree --db PATH --quiet
 */
import { parseArgs } from "node:util";
import readline from "node:readline";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type * as schema from "@agentclientprotocol/sdk";
import { Hub } from "../core/hub.js";
import { AGENTS } from "../core/agents.js";
import { POLICIES, type AgentSession, type PermissionPolicy, type SessionEvent } from "../core/session.js";
import { Scheduler, parseDuration, formatDuration, describeSchedule as schedule, type JobEvent } from "../core/scheduler.js";
import { probe, installed } from "../core/doctor.js";
import { ROLES, type RolePreset } from "../core/roles.js";
import { defaultDb } from "../core/home.js";
import { BB_PREFIX, BRANCHES } from "../core/watch.js";
import { buildReport, renderReport } from "../core/report.js";
import { RECIPES, applyRecipe } from "../core/recipes.js";
import { findSkill, listSkills, parseSkill, projectSkillsDir, skillTemplate, userSkillsDir } from "../core/skills.js";
import { runSkill, writeSkill } from "../core/skill-run.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { listWorktrees, mergeWorktree, removeWorktree, syncWorktree } from "../core/worktree.js";
import { HiveDb, type JobRow, type NewJob } from "../hive/db.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    cwd: { type: "string" },
    role: { type: "string" },
    policy: { type: "string" },
    db: { type: "string" },
    quiet: { type: "boolean", short: "q", default: false },
    fresh: { type: "boolean", default: false },
    times: { type: "string" },
    hours: { type: "string" },
    for: { type: "string" },
    "min-lines": { type: "string" },
    "max-wait": { type: "string" },
    in: { type: "string" },
    at: { type: "string" },
    "keep-context": { type: "boolean", default: false },
    detach: { type: "boolean", short: "d", default: false },
    all: { type: "boolean", default: false },
    quick: { type: "boolean", default: false },
    as: { type: "string" },
    since: { type: "string" },
    subject: { type: "string" },
    worktree: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    branches: { type: "boolean", default: false },
    bb: { type: "string" },
    alt: { type: "string" },
    agent: { type: "string" },
    prefix: { type: "string" },
    describe: { type: "string" },
    project: { type: "boolean", default: false },
    out: { type: "string" },
    cooldown: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});
const [cmd, ...rest] = positionals;
// One hive per repo, kept outside the workspace (see core/home.ts).
values.db = resolve(values.db ?? defaultDb(values.cwd ?? process.cwd()));

const tty = process.stdout.isTTY;
const color = (n: number) => (s: string) => (tty ? `\x1b[${n}m${s}\x1b[0m` : s);
const dim = color(2);
const cyan = color(36);
const yellow = color(33);
const red = color(31);
const green = color(32);

const USAGE = `hive — local multi-agent harness

  hive run <agent> [opts] "prompt"        one prompt, wait for replies, exit
  hive chat <agent> [opts]                interactive; resumes last session (--fresh for new)
  hive agents                             list hive members
  hive doctor [agent...] [--quick]        installed? speaks ACP? logged in?
  hive ui [--cwd DIR]                     open the pane UI for this project

  hive loop <agent> --times 5 "prompt"    run N times, fresh session each, shared notes file
  hive loop <agent> --for 8h "prompt"     … until time is up
  hive every <agent> 10m "prompt"         on an interval
  hive watch <agent> <path> [--min-lines 50] [--max-wait 30m] "prompt"
  hive watch <agent> --branches "prompt"  fire on new commits on agents' hive/* branches
  hive watch <agent> --bb ideas/raw/ "prompt"   fire when agents post blackboard entries under a prefix
      watch options: --min-lines N (or min new entries)  --max-wait 30m (any change after T)  --cooldown 10m (at most every T)
  hive groups · hive group create|add|rm|delete <name> [members…]   mail "@name" reaches all members
  hive recipe list · hive recipe apply <id> [--agent claude] [--alt codex]   a ready-made team (review-loop, solid-code, idea-pipeline, studio)
  hive skill list · hive skill run <name> k=v … · hive skill new <name> [--describe "…"]   reusable prompts with parameters
  hive once <agent> [--in 20m | --at 2026-10-01T09:00] "prompt"
  hive jobs [--all]                       list jobs
  hive job stop|start|runs|rm <id>
  hive serve                              run all jobs + mail delivery until Ctrl-C
  hive start <agent> --as security|scout|bughunter    run a preset's default job

  hive report [--since 12h]               what happened: job runs + summaries, commits, mail to you
  hive inbox [--all]                      mail agents sent to you ("owner")
  hive send <agent|*> "text"              message an agent as the owner (it's woken to read it)
  hive bb [prefix] · hive bb rm <key>     the shared blackboard (ideas/, security/, claim/…)

  hive worktrees                          agent branches: ahead/behind, diffstat, dirty
  hive merge <name>                       merge hive/<name> into the main checkout
  hive sync <name>                        merge the main branch into the agent's worktree
  hive log <agent> [--times N]            what an agent was asked and answered
  hive worktree rm <name> [--force]

examples (the four everyday setups):
  hive chat claude --as coder                            a coder you talk to, in its own worktree
  hive loop claude --as bughunter --for 8h -d "hunt bugs in src/"    overnight bug hunt (then: hive serve)
  hive start codex --as security -d                      rescans when enough new lines land (agent branches too)
  hive start claude --as scout -d                        feature ideas every 10 minutes → hive bb ideas/
  hive serve        ·  hive report --since 12h  ·  hive inbox  ·  hive ui

agents:  ${Object.keys(AGENTS).join(", ")}
presets: ${Object.values(ROLES).map((r) => r.id).join(", ")}  (--as: role + policy + briefing [+ worktree])
options: --name N  --cwd DIR  --role R  --policy ${POLICIES.join("|")}  --worktree
         --db PATH (default: per-repo hive in your user state dir)  --keep-context  --detach  --quiet`;

// ---- one readline for the whole process (chat input, permission prompts, questions) ----

let rl: readline.Interface | undefined;
let answer: ((s: string) => void) | undefined;
function getRl() {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on("line", (line) => {
      const a = answer;
      if (a) {
        answer = undefined;
        a(line);
      } else lineHandler?.(line);
    });
    rl.on("SIGINT", () => sigintHandler());
    rl.on("close", () => closeHandler?.());
  }
  return rl;
}
let lineHandler: ((line: string) => void) | undefined;
let closeHandler: (() => void) | undefined;
let sigintHandler: () => void = () => process.kill(process.pid, "SIGINT");

function ask(q: string): Promise<string> {
  if (!process.stdin.isTTY && !rl) return Promise.resolve("");
  const r = getRl();
  return new Promise((res) => {
    answer = res;
    r.setPrompt("");
    process.stdout.write(q);
  });
}

// ---- rendering ----

let lastAgent = "";
let midLine = false;
function render(agent: string, e: SessionEvent) {
  const tag = cyan(`[${agent}]`);
  const line = (s: string, err = false) => {
    if (midLine) process.stdout.write("\n");
    midLine = false;
    (err ? console.error : console.log)(s);
  };
  const stream = (s: string) => {
    if (agent !== lastAgent || !midLine) {
      if (midLine) process.stdout.write("\n");
      process.stdout.write(`${tag} `);
    }
    process.stdout.write(s);
    midLine = !s.endsWith("\n");
    if (!midLine) lastAgent = "";
    else lastAgent = agent;
  };
  switch (e.type) {
    case "text":
      stream(e.text);
      break;
    case "thought":
      if (!values.quiet) stream(dim(e.text));
      break;
    case "tool_call":
      line(`${tag} ${yellow("⚙")} ${e.title} ${dim(e.status)}`);
      break;
    case "tool_update":
      if (e.status === "failed") line(`${tag} ${red(`⚙ ${e.title ?? e.id} failed`)}`);
      break;
    case "permission":
      line(`${tag} ${yellow("🔐")} ${e.title} → ${e.decision}`);
      break;
    case "elicitation":
      line(`${tag} ${yellow("?")} ${e.message} → ${e.action}`);
      break;
    case "session":
      if (!values.quiet) line(`${tag} ${dim(`session ${e.how}: ${e.sessionId}`)}`);
      break;
    case "turn_end": {
      const u = e.usage as { totalTokens?: number } | undefined;
      line(`${tag} ${dim(`— ${e.stopReason}${u?.totalTokens ? ` · ${u.totalTokens} tok` : ""}`)}`);
      break;
    }
    case "status":
      if (e.status === "error") line(`${tag} ${red(`ERROR ${e.note ?? ""}`)}`, true);
      break;
    case "notice":
      if (!values.quiet) line(`${tag} ${dim(e.text)}`, true);
      break;
    case "exit":
      line(`${tag} exited ${e.code}`);
      break;
  }
}

function renderJob(e: JobEvent) {
  const tag = green(`[job ${e.job.id}]`);
  const say = (s: string) => {
    if (midLine) process.stdout.write("\n");
    midLine = false;
    console.log(`${tag} ${s}`);
  };
  switch (e.type) {
    case "run_start":
      say(`▶ run ${e.iteration}${e.job.kind === "loop" && e.job.remaining != null ? `/${e.iteration - 1 + e.job.remaining}` : ""} on ${e.job.agent}`);
      break;
    case "run_end":
      say(dim(`■ run ${e.iteration} ${e.result.stopReason}${e.result.error ? `: ${e.result.error}` : ""}`));
      break;
    case "job_end":
      say(`ended: ${e.reason}`);
      break;
    case "watch":
      if (!values.quiet) say(dim(`${e.lines} changed line${e.lines === 1 ? "" : "s"}${e.fired ? " → firing" : ` (need ${e.job.watch_min_lines ?? 50})`}`));
      break;
    case "error":
      say(red(e.error));
      break;
    case "paused":
      say(yellow(`paused (usage limit) until ${new Date(e.until).toLocaleTimeString()}`));
      break;
  }
}

async function askPermission(req: schema.RequestPermissionRequest, agent: string, signal?: AbortSignal): Promise<string> {
  // If the session gives up (Ctrl-C / cancel), stop waiting for this answer.
  signal?.addEventListener("abort", () => {
    if (answer) {
      const a = answer;
      answer = undefined;
      console.log(dim("\n(permission request withdrawn)"));
      a("");
    }
  });
  if (!process.stdin.isTTY) return req.options.find((o) => o.kind.startsWith("reject"))?.optionId ?? req.options[0].optionId;
  console.log(`\n${cyan(`[${agent}]`)} ${yellow("🔐")} ${req.toolCall.title ?? "tool"}${(req.toolCall as any).kind ? dim(` (${(req.toolCall as any).kind})`) : ""}`);
  req.options.forEach((o, i) => console.log(`  ${i + 1}. ${o.name} ${dim(`(${o.kind})`)}`));
  const a = await ask("choose: ");
  const i = parseInt(a.trim(), 10) - 1;
  return req.options[i]?.optionId ?? req.options.find((o) => o.kind.startsWith("reject"))?.optionId ?? req.options[0].optionId;
}

async function elicit(req: schema.CreateElicitationRequest, agent: string): Promise<schema.CreateElicitationResponse> {
  if (!process.stdin.isTTY) return { action: "decline" };
  console.log(`\n${cyan(`[${agent}]`)} ${yellow("?")} ${req.message}`);
  if (req.mode === "url") {
    console.log(`  open: ${(req as any).url}`);
    const a = await ask("done? [y/N] ");
    return { action: /^y/i.test(a) ? "accept" : "decline" };
  }
  const props = ((req as any).requestedSchema?.properties ?? {}) as Record<string, any>;
  const content: Record<string, string | number | boolean | string[]> = {};
  for (const [key, p] of Object.entries(props)) {
    const label = p.title ?? key;
    const choices: string[] | undefined = p.enum ?? p.oneOf?.map((o: any) => o.const);
    const hint = choices ? ` [${choices.join("/")}]` : p.type === "boolean" ? " [y/n]" : "";
    const a = (await ask(`  ${label}${p.description ? dim(` — ${p.description}`) : ""}${hint}: `)).trim();
    if (a === "" && !(req as any).requestedSchema?.required?.includes(key)) continue;
    if (p.type === "boolean") content[key] = /^y/i.test(a);
    else if (p.type === "number" || p.type === "integer") content[key] = Number(a);
    else if (p.type === "array") content[key] = a.split(",").map((s) => s.trim()).filter(Boolean);
    else content[key] = a;
  }
  return { action: "accept", content };
}

// ---- helpers ----

function die(msg: string): never {
  console.error(red(msg));
  process.exit(1);
}

function agentArg(a: string | undefined, usage: string): string {
  if (!a) die(`usage: ${usage}`);
  if (!AGENTS[a]) die(`unknown agent "${a}" (known: ${Object.keys(AGENTS).join(", ")})`);
  return a;
}

function policyArg(def: PermissionPolicy): PermissionPolicy {
  const p = (values.policy ?? preset()?.policy ?? def) as PermissionPolicy;
  if (!POLICIES.includes(p)) die(`unknown policy "${p}" (use ${POLICIES.join(", ")})`);
  return p;
}

/**
 * Path to the Electron binary, downloading it if npm skipped electron's
 * postinstall (happens with some npm setups / npm ci).
 */
function ensureElectron(): string {
  const req = createRequire(import.meta.url);
  let bin = req("electron") as unknown as string;
  if (!existsSync(bin)) {
    console.log(dim("downloading Electron (first run)…"));
    const r = spawnSync(process.execPath, [req.resolve("electron/install.js")], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("electron download failed");
    bin = req("electron") as unknown as string;
    if (!existsSync(bin)) throw new Error(`electron binary still missing at ${bin}`);
  }
  return bin;
}

/** Coders work on hive/* branches in their own worktrees; a watcher should follow those. */
async function hasAgentBranches(cwd: string): Promise<boolean> {
  try {
    const w = await listWorktrees(cwd);
    if (w.worktrees.length) console.log(dim(`watching agent branches (hive/*): ${w.worktrees.map((x) => x.name).join(", ")} — use --branches explicitly to force`));
    return w.worktrees.length > 0;
  } catch {
    return false;
  }
}

function preset(): RolePreset | undefined {
  if (!values.as) return undefined;
  const r = ROLES[values.as];
  if (!r) die(`unknown preset "${values.as}" (${Object.keys(ROLES).join(", ")})`);
  return r;
}

function prompt(words: string[]): string {
  const p = words.join(" ").trim();
  if (!p) die(`missing prompt (put it in quotes after the other arguments)`);
  return p;
}

function positiveInt(s: string, what: string): number {
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0) die(`${what} must be a positive integer, got "${s}"`);
  return n;
}

function duration(s: string, what: string): number {
  try {
    return parseDuration(s);
  } catch (e: any) {
    die(`${what}: ${e.message}`);
  }
}

function newHub(opts: { wakeSleeping?: boolean } = {}): Hub {
  return new Hub({ hiveDb: values.db!, onEvent: render, defaults: { askPermission, elicit }, ...opts });
}

/** Paths inside the project print relative to it. */
function shortCwd(p: string): string {
  const base = resolve(values.cwd ?? process.cwd());
  if (p === base) return ".";
  if (p.startsWith(base + "/") || p.startsWith(base + "\\")) return p.slice(base.length + 1);
  const wt = p.match(/[\\/]worktrees[\\/]([^\\/]+)$/);
  return wt ? `(worktree ${wt[1]})` : p;
}

function ago(ts: number | null): string {
  if (!ts) return "-";
  const d = Date.now() - ts;
  return d >= 0 ? `${formatDuration(Math.max(1000, d))} ago` : `in ${formatDuration(-d)}`;
}

/** Run jobs in this process until they end; Ctrl-C stops them. */
async function runJobsForeground(hub: Hub, jobIds: number[]) {
  const sched = new Scheduler({ hub, jobIds, onJob: renderJob, closeIdleAgents: true, owner: fgOwner });
  hub.run();
  let stopping = false;
  const stop = async () => {
    if (stopping) return process.exit(130);
    stopping = true;
    console.log(dim("\nstopping… (Ctrl-C again to force)"));
    for (const id of jobIds) if (hub.db.getJob(id)?.enabled) hub.db.endJob(id, "stopped");
    for (const s of hub.sessions.values()) if (s.busyNow) await s.cancel().catch(() => {});
  };
  sigintHandler = () => void stop();
  process.on("SIGINT", sigintHandler);
  sched.start();
  await sched.idle();
  await sched.stop();
  await hub.close();
  const jobs = jobIds.map((id) => new HiveDb(values.db!).getJob(id));
  for (const j of jobs) if (j) console.log(dim(`job ${j.id}: ${j.ended_reason ?? "ended"} after ${j.runs} run${j.runs === 1 ? "" : "s"}${j.last_error ? ` — last error: ${j.last_error}` : ""}`));
}

/** Insert a job (from loop/every/watch/once) then run it here or leave it for `hive serve`. */
async function submitJob(j: Omit<NewJob, "agent" | "cwd" | "policy" | "role" | "fresh_session"> & { agentKind: string }) {
  const cwd = resolve(values.cwd ?? process.cwd());
  const policy = policyArg("allow-reads");
  if (values.detach && policy === "ask") console.warn(yellow(`--policy ask with --detach: nobody will be there to answer, requests will be rejected`));
  const db = new HiveDb(values.db!);
  const r = preset();
  const id = db.addJob({
    ...j,
    agent: values.name ?? `pending-${Date.now()}`,
    cwd,
    policy,
    role: values.role ?? r?.role ?? "",
    briefing: r?.briefing ?? "",
    worktree: values.worktree || r?.worktree ? 1 : 0,
    fresh_session: values["keep-context"] ? 0 : 1,
    // A foreground job is ours from the start, so a running `hive serve` can't grab it.
    ...(values.detach ? {} : { owner: fgOwner, lease_until: Date.now() + 30_000 }),
  });
  // Preset jobs get the preset's name (security, scout, bughunter); others <kind>-<id>.
  if (!values.name) {
    const taken = db.getAgent(r?.id ?? "");
    const name = r && (!taken || taken.kind === j.agent_kind) ? r.id : `${j.agent_kind}-${id}`;
    db.updateJob(id, { agent: name });
  }
  const job = db.getJob(id)!;
  // Visible in the hive (hive agents, hive send) before its first run.
  if (!db.getAgent(job.agent)) {
    db.upsertAgent({ name: job.agent, kind: job.agent_kind, cwd, role: job.role, status: "asleep", status_note: `waiting for job ${id}`, session_id: null });
    db.setAgentConfig(job.agent, policy, r?.id ?? null);
  }
  db.close();
  console.log(`${green(`job ${id}`)} ${job.kind} on ${job.agent} (${job.agent_kind}, ${policy}) — ${schedule(job)}`);
  if (values.detach) {
    console.log(dim(`queued. Run \`hive serve\` to execute; \`hive job stop ${id}\` to cancel.`));
    return;
  }
  await runJobsForeground(newHub(), [id]);
}
const fgOwner = `fg-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

// ---- commands ----

async function main() {
  if (values.help || !cmd || cmd === "help") {
    console.log(USAGE);
    return;
  }
  switch (cmd) {
    case "agents": {
      const db = new HiveDb(values.db!);
      const rows = db.listAgents();
      if (!rows.length) console.log(dim("no agents yet"));
      else
        console.table(
          rows.map((a) => ({
            name: a.name,
            kind: a.kind,
            role: a.role || a.preset || "",
            status: db.effectiveStatus(a),
            unread: db.unreadCount(a.name),
            seen: ago(a.last_seen),
            note: a.status_note.slice(0, 40),
            where: shortCwd(a.cwd),
          })),
        );
      db.close();
      return;
    }

    case "doctor": {
      const ids = rest.length ? rest : Object.keys(AGENTS);
      for (const id of ids) if (!AGENTS[id]) die(`unknown agent "${id}"`);
      console.log(dim(values.quick ? "PATH check only" : "probing with ACP initialize (npx adapters may download on first run)…"));
      await Promise.all(
        ids.map(async (id) => {
          const def = AGENTS[id];
          if (values.quick) {
            const inst = installed(def);
            console.log(`${id.padEnd(9)} ${(inst === "npx" ? "npx (on demand)" : inst).padEnd(16)} ${dim(def.install)}`);
            return;
          }
          const r = await probe(def);
          if (r.ok) {
            console.log(
              `${green("✓")} ${id.padEnd(9)} ${r.agent ?? ""} ${dim(`proto v${r.protocolVersion}`)} auth: ${r.auth && !/^(not |unknown)/.test(r.auth) ? green(r.auth) : yellow(r.auth ?? "?")} ${dim(`[${r.features?.join(", ")}] ${r.ms}ms`)}`,
            );
          } else {
            console.log(`${red("✗")} ${id.padEnd(9)} ${r.error}${r.stderr ? "\n" + dim(r.stderr.replace(/^/gm, "    ")) : ""}`);
            if (r.installed !== "missing") console.log(dim(`    ${def.install}`));
          }
        }),
      );
      return;
    }

    case "run":
    case "chat": {
      const agent = agentArg(rest[0], `hive ${cmd} <agent> [--name N] [--cwd D] [--policy P] ${cmd === "run" ? '"prompt"' : ""}`);
      const name = values.name ?? agent;
      const hub = newHub();
      // Reopening a known agent: same folder (its worktree), role, policy and
      // preset — and so the same ACP session — unless flags say otherwise.
      const prev = hub.db.getAgent(name);
      const reuse = !!prev && prev.kind === agent && !values.cwd && !values.as && !values.worktree && !!prev.cwd && existsSync(prev.cwd);
      if (prev && prev.kind && prev.kind !== agent) {
        await hub.close();
        die(`"${name}" is a ${prev.kind} agent in this hive; pick another --name`);
      }
      if (prev?.kind && !reuse && prev.cwd && (values.cwd || values.as || values.worktree))
        console.log(dim(`note: ${name} previously ran in ${prev.cwd}${prev.preset ? ` as ${prev.preset}` : ""}; starting with the new settings`));
      const cwd = reuse ? prev!.cwd : (values.cwd ?? process.cwd());
      if (!existsSync(cwd)) die(`--cwd ${cwd} does not exist`);
      const text = cmd === "run" ? prompt(rest.slice(1)) : "";
      const presetId = values.as ?? (reuse ? (prev!.preset ?? undefined) : undefined);
      const r = presetId ? ROLES[presetId] : undefined;
      if (presetId && !r) die(`unknown preset "${presetId}"`);
      let s: AgentSession;
      try {
        s = await hub.add({
          name,
          agent,
          cwd,
          role: values.role ?? (reuse ? prev!.role : (r?.role ?? "")),
          policy: (values.policy as PermissionPolicy) ?? (reuse && prev!.policy ? (prev!.policy as PermissionPolicy) : policyArg("ask")),
          briefing: r?.briefing ?? (reuse ? (prev!.briefing ?? undefined) : undefined),
          preset: presetId,
          // ensureWorktree finds the agent's existing worktree, so this is safe on reopen too.
          worktree: values.worktree || r?.worktree,
          resume: !values.fresh,
        });
      } catch (e: any) {
        await hub.close();
        die(`could not start ${agent}: ${e?.message ?? e}\nrun \`hive doctor ${agent}\` to diagnose`);
      }
      hub.run();
      if (cmd === "run") {
        const onInt = () => void s.cancel();
        process.on("SIGINT", onInt);
        await s.prompt(text);
        await hub.settle(10 * 60_000).catch(() => {});
        await hub.close();
        return;
      }
      return chat(hub, s);
    }

    case "loop": {
      const agent = agentArg(rest[0], `hive loop <agent> --times N | --for 8h "prompt"`);
      const text = prompt(rest.slice(1));
      const times = values.times ? positiveInt(values.times, "--times") : undefined;
      const forMs = values.for ? duration(values.for, "--for") : values.hours ? Number(values.hours) * 3_600_000 : undefined;
      if (forMs != null && !(forMs > 0)) die(`--hours must be a positive number`);
      if (times == null && forMs == null) die(`loop needs --times N and/or --for DURATION (e.g. --for 8h)`);
      return submitJob({ kind: "loop", agent_kind: agent, agentKind: agent, prompt: text, remaining: times ?? null, until_ts: forMs ? Date.now() + forMs : null });
    }

    case "every": {
      const agent = agentArg(rest[0], `hive every <agent> <10m> "prompt"`);
      if (!rest[1]) die(`usage: hive every <agent> <10m> "prompt"`);
      const every = duration(rest[1], "interval");
      const text = prompt(rest.slice(2));
      const forMs = values.for ? duration(values.for, "--for") : undefined;
      return submitJob({ kind: "interval", agent_kind: agent, agentKind: agent, prompt: text, every_ms: every, until_ts: forMs ? Date.now() + forMs : null });
    }

    case "watch": {
      const agent = agentArg(rest[0], `hive watch <agent> <path>|--branches [--min-lines 50] "prompt"`);
      let path: string;
      let text: string;
      if (values.branches) {
        path = BRANCHES;
        text = prompt(rest.slice(1));
      } else if (values.bb !== undefined) {
        path = BB_PREFIX + values.bb;
        text = prompt(rest.slice(1));
      } else {
        if (!rest[1]) die(`usage: hive watch <agent> <path>|--branches [--min-lines 50] "prompt"`);
        path = resolve(values.cwd ?? process.cwd(), rest[1]);
        if (!existsSync(path)) die(`watch path ${path} does not exist`);
        text = prompt(rest.slice(2));
      }
      return submitJob({
        kind: "watch",
        agent_kind: agent,
        agentKind: agent,
        prompt: text,
        watch_path: path,
        watch_min_lines: values["min-lines"] ? positiveInt(values["min-lines"], "--min-lines") : path.startsWith(BB_PREFIX) ? 1 : 50,
        every_ms: values["max-wait"] ? duration(values["max-wait"], "--max-wait") : null,
        cooldown_ms: values.cooldown ? duration(values.cooldown, "--cooldown") : null,
      });
    }

    case "once": {
      const agent = agentArg(rest[0], `hive once <agent> [--in 20m | --at TIME] "prompt"`);
      const text = prompt(rest.slice(1));
      let at = Date.now();
      if (values.in) at += duration(values.in, "--in");
      else if (values.at) {
        at = new Date(values.at).getTime();
        if (Number.isNaN(at)) die(`--at: can't parse "${values.at}" (use e.g. 2026-10-01T09:00)`);
      }
      return submitJob({ kind: "once", agent_kind: agent, agentKind: agent, prompt: text, next_run: at });
    }

    case "jobs": {
      const db = new HiveDb(values.db!);
      const jobs = db.listJobs(values.all);
      if (!jobs.length) console.log(dim(values.all ? "no jobs" : "no active jobs (--all to include ended)"));
      else
        console.table(
          jobs.map((j) => ({
            id: j.id,
            kind: j.kind,
            agent: `${j.agent} (${j.agent_kind})`,
            schedule: schedule(j),
            runs: j.runs,
            state: j.enabled ? (j.owner ? "running" : "queued") : j.ended_reason ?? "ended",
            next: j.enabled && j.kind !== "watch" ? (j.next_run <= Date.now() ? "due" : ago(j.next_run)) : j.enabled ? "on change" : "-",
            last: ago(j.last_run),
            error: (j.last_error ?? "").slice(0, 40),
            prompt: j.prompt.slice(0, 40),
          })),
        );
      if (jobs.some((j) => j.enabled && !j.owner)) console.log(dim("queued jobs run when `hive serve` is running"));
      db.close();
      return;
    }

    case "job": {
      const [sub, idS] = rest;
      if (!sub || !idS) die(`usage: hive job stop|start|runs|show|rm <id|agent>`);
      const db = new HiveDb(values.db!);
      let id: number;
      if (/^\d+$/.test(idS)) id = Number(idS);
      else {
        // An agent name: its active job (or latest job).
        const js = db.listJobs(true).filter((x) => x.agent === idS);
        const pick = js.filter((x) => x.enabled).at(-1) ?? js.at(-1);
        if (!pick) die(`no job for agent "${idS}"`);
        if (js.filter((x) => x.enabled).length > 1) console.log(dim(`${idS} has several active jobs; using #${pick.id}`));
        id = pick.id;
      }
      const j = db.getJob(id);
      if (!j) die(`no job ${id}`);
      switch (sub) {
        case "stop":
          if (!j.enabled) console.log(dim(`job ${id} already ended (${j.ended_reason})`));
          else {
            db.endJob(id, "stopped");
            console.log(`job ${id} stopped${j.owner ? " (its running turn will be cancelled)" : ""}`);
          }
          break;
        case "start":
          db.updateJob(id, { enabled: 1, ended_reason: null, failures: 0, last_error: null, next_run: Date.now() });
          console.log(`job ${id} re-enabled${j.kind === "loop" && j.remaining === 0 ? dim(" (remaining is 0 — it will end immediately; add --times with a new job instead)") : ""}`);
          break;
        case "runs": {
          const runs = db.jobRuns(id);
          if (!runs.length) console.log(dim("no runs yet"));
          else
            console.table(
              runs.map((r) => ({
                run: r.iteration,
                started: new Date(r.started).toLocaleString(),
                took: r.ended ? formatDuration(r.ended - r.started) : "running",
                stop: r.stop_reason ?? "",
                tokens: r.usage ? (JSON.parse(r.usage).totalTokens ?? "") : "",
                summary: (r.error ?? r.summary ?? "").replace(/\s+/g, " ").slice(-70),
              })),
            );
          console.log(dim(`full summaries: hive job show ${id}`));
          break;
        }
        case "show": {
          console.log(`${green(`job ${id}`)} ${j.kind} on ${j.agent} — ${schedule(j)} — ${j.enabled ? "active" : (j.ended_reason ?? "ended")}\n${dim(j.prompt)}\n`);
          for (const r of db.jobRuns(id, 500).reverse()) {
            console.log(`${cyan(`run ${r.iteration}`)} ${dim(new Date(r.started).toLocaleString())} ${r.stop_reason ?? "running"}${r.ended ? dim(` · ${formatDuration(r.ended - r.started)}`) : ""}`);
            if (r.summary) console.log("  " + r.summary.trim().replace(/\n/g, "\n  "));
            if (r.error) console.log(red("  " + r.error));
            console.log();
          }
          break;
        }
        case "rm":
          if (j.enabled) die(`job ${id} is still active; \`hive job stop ${id}\` first`);
          db.db.prepare(`DELETE FROM job_runs WHERE job_id=?`).run(id);
          db.db.prepare(`DELETE FROM jobs WHERE id=?`).run(id);
          console.log(`job ${id} removed`);
          break;
        default:
          die(`unknown job subcommand "${sub}" (stop|start|runs|show|rm)`);
      }
      db.close();
      return;
    }

    case "start": {
      const agent = agentArg(rest[0], `hive start <agent> --as ${Object.values(ROLES).filter((r) => r.job).map((r) => r.id).join("|")}`);
      const r = preset();
      if (!r) die(`hive start needs --as <preset>: ${Object.values(ROLES).filter((x) => x.job).map((x) => x.id).join(", ")}`);
      if (!r.job) die(`the ${r.id} preset has no job to start — talk to it with \`hive chat ${agent} --as ${r.id}\` (or \`hive ui\`)`);
      const extra = rest.slice(1).join(" ").trim();
      const cwd = resolve(values.cwd ?? process.cwd());
      return submitJob({
        kind: r.job.kind,
        agent_kind: agent,
        agentKind: agent,
        prompt: extra ? `${r.job.prompt}\n\n${extra}` : r.job.prompt,
        remaining: r.job.kind === "loop" ? (values.times ? positiveInt(values.times, "--times") : (r.job.remaining ?? null)) : null,
        until_ts: values.for ? Date.now() + duration(values.for, "--for") : null,
        every_ms: r.job.kind === "interval" ? (r.job.every_ms ?? null) : null,
        watch_path: r.job.kind === "watch" ? (values.branches || (await hasAgentBranches(cwd)) ? BRANCHES : cwd) : null,
        watch_min_lines: values["min-lines"] ? positiveInt(values["min-lines"], "--min-lines") : (r.job.watch_min_lines ?? null),
      });
    }

    case "ui": {
      // Electron's npm package exports the path of its binary.
      const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
      const main = join(repoRoot, "dist-ui", "main.cjs");
      const build = join(repoRoot, "scripts", "build-ui.mjs");
      if (existsSync(build)) {
        const b = spawnSync(process.execPath, [build], { cwd: repoRoot, encoding: "utf8" });
        if (b.status !== 0) die(`UI build failed:\n${b.stderr}`);
      } else if (!existsSync(main)) die(`UI not built: ${main} missing`);
      let electronBin: string;
      try {
        electronBin = ensureElectron();
      } catch (e: any) {
        die(`electron is not available: ${e?.message ?? e} (run npm install in the hive checkout)`);
      }
      const cwd = resolve(values.cwd ?? process.cwd());
      const args = [main, "--cwd", cwd, ...(values.db !== resolve(defaultDb(cwd)) ? ["--db", values.db!] : [])];
      // Chromium refuses to run as root with its sandbox on Linux.
      if (process.platform === "linux" && process.getuid?.() === 0) args.push("--no-sandbox");
      console.log(dim(`opening hive for ${cwd}`));
      const child = spawn(electronBin, args, { stdio: "inherit", env: { ...process.env, HIVE_NODE: process.env.HIVE_NODE ?? process.execPath } });
      await new Promise<void>((res) => child.on("exit", () => res()));
      return;
    }

    case "report": {
      const since = Date.now() - (values.since ? duration(values.since, "--since") : 12 * 3_600_000);
      const db = new HiveDb(values.db!);
      const cwds = [values.cwd ?? process.cwd(), ...db.listAgents().map((a) => a.cwd).filter(Boolean)];
      console.log(renderReport(await buildReport(db, since, cwds)));
      db.close();
      return;
    }

    case "inbox": {
      const db = new HiveDb(values.db!);
      const msgs = db.inbox("owner", !values.all, 100);
      if (!msgs.length) console.log(dim(values.all ? "no mail" : "no unread mail (--all for history)"));
      for (const m of [...msgs].reverse())
        console.log(`${cyan(m.from_agent)} ${dim(new Date(m.ts).toLocaleString())} ${m.to_agent === "*" ? dim("(to all) ") : ""}${m.subject}\n  ${m.body.replace(/\n/g, "\n  ")}\n`);
      db.markRead(msgs.filter((m) => m.read_at == null).map((m) => m.id), "owner");
      db.close();
      return;
    }

    case "send": {
      const [to, ...words] = rest;
      if (!to) die(`usage: hive send <agent|*> "text" [--subject S]`);
      const body = prompt(words);
      const db = new HiveDb(values.db!);
      if (to.startsWith("@") ? !db.groupMembers(to.slice(1)).length : to !== "*" && !db.getAgent(to))
        die(`no agent or group "${to}" (agents: ${db.listAgents().map((a) => a.name).join(", ") || "none"}; groups: ${db.groups().map((g) => "@" + g.name).join(", ") || "none"})`);
      const id = db.send("owner", to, values.subject ?? body.split("\n")[0].slice(0, 80), body);
      const a = to === "*" ? undefined : db.getAgent(to);
      console.log(`sent #${id} to ${to}${a && a.status === "asleep" ? dim(` (${to} is asleep; it gets this when it next runs)`) : ""}`);
      db.close();
      return;
    }

    case "bb": {
      const db = new HiveDb(values.db!);
      if (rest[0] === "rm") {
        if (!rest[1]) die("usage: hive bb rm <key>");
        db.bbDelete(rest[1]);
        console.log(`deleted ${rest[1]}`);
      } else {
        const rows = db.bbList(rest[0] ?? "");
        if (!rows.length) console.log(dim("blackboard is empty"));
        for (const e of rows) console.log(`${cyan(e.key)} ${dim(`${e.updated_by} · ${ago(e.updated_at)}`)}\n  ${e.value.replace(/\n/g, "\n  ")}`);
      }
      db.close();
      return;
    }

    case "worktrees": {
      const { repo, base, worktrees } = await listWorktrees(values.cwd ?? process.cwd());
      if (!worktrees.length) console.log(dim(`no hive worktrees in ${repo} (use --worktree or --as coder)`));
      else {
        console.log(dim(`${repo} — base ${base}`));
        console.table(
          worktrees.map((w) => ({
            name: w.name,
            branch: w.branch,
            ahead: w.ahead,
            behind: w.behind,
            diff: `${w.files} files +${w.insertions} -${w.deletions}`,
            uncommitted: w.dirty,
          })),
        );
      }
      return;
    }

    case "merge": {
      if (!rest[0]) die("usage: hive merge <agent-name>");
      const r = await mergeWorktree(values.cwd ?? process.cwd(), rest[0]);
      (r.ok ? console.log : console.error)(r.ok ? green(r.message) : red(r.message));
      if (!r.ok) process.exitCode = 1;
      return;
    }

    case "skills":
    case "skill": {
      const cwd = resolve(values.cwd ?? process.cwd());
      const [sub, name, ...kv] = cmd === "skills" ? ["list"] : rest;
      if (!sub || sub === "list") {
        const all = listSkills(cwd);
        for (const sk of all) console.log(`${cyan(sk.name.padEnd(16))} ${dim(sk.source.padEnd(8))} ${sk.description}`);
        console.log(dim(`\nrun:  hive skill run <name> param=value … (file params take a path)\nnew:  hive skill new <name> [--describe "what it should do"] [--project]\nuser skills: ${userSkillsDir()}   project skills: ${projectSkillsDir(cwd)}`));
        return;
      }
      if (!name) die(`usage: hive skill ${sub} <name>`);
      if (sub === "show") {
        const sk = findSkill(cwd, name);
        console.log(`${cyan(sk.name)} — ${sk.description}\n${dim(sk.path)}\nagent: ${sk.agent ?? "claude"} · policy: ${sk.policy}${sk.output ? ` · saves to ${sk.output}` : ""}\nparams:`);
        for (const p of sk.params) console.log(`  ${p.name}${p.required ? "*" : ""} (${p.type}${p.choices ? `: ${p.choices.join("|")}` : ""}${p.default ? `, default ${p.default}` : ""})${p.description ? dim(` — ${p.description}`) : ""}`);
        return;
      }
      if (sub === "new") {
        if (!/^[\w.-]{1,60}$/.test(name)) die(`invalid skill name "${name}"`);
        const dir = values.project ? projectSkillsDir(cwd) : userSkillsDir();
        const file = join(dir, `${name}.md`);
        if (existsSync(file) && !values.force) die(`${file} exists (--force to overwrite)`);
        let text = skillTemplate(name);
        if (values.describe) {
          const kind = values.agent ?? "claude";
          console.log(dim(`asking ${kind} to write the skill…`));
          const hub = newHub();
          try {
            text = await writeSkill(hub, name, values.describe, { cwd, kind });
          } finally {
            await hub.close();
          }
        }
        parseSkill(text, file);
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, text);
        console.log(`${green("created")} ${file}\n${dim(`edit it, then: hive skill run ${name} …`)}`);
        return;
      }
      if (sub === "edit") {
        console.log(findSkill(cwd, name).path);
        return;
      }
      if (sub === "run") {
        const sk = findSkill(cwd, name);
        const params: Record<string, string> = {};
        for (const a of kv) {
          const m = a.match(/^([\w-]+)=([\s\S]*)$/);
          if (!m) die(`parameters look like name=value (got "${a}")`);
          params[m[1]] = m[2];
        }
        const hub = newHub();
        try {
          const r = await runSkill(hub, sk, params, { cwd, kind: values.agent });
          if (r.result.error) process.exitCode = 1;
          if (values.out) {
            writeFileSync(resolve(cwd, values.out), r.reply);
            console.log(dim(`\nsaved to ${resolve(cwd, values.out)}`));
          } else if (r.saved) console.log(dim(`\nsaved to ${r.saved}`));
          console.log(dim(`follow up: hive chat ${values.agent ?? sk.agent ?? "claude"} --name ${r.agent}`));
        } catch (e: any) {
          die(e.message);
        } finally {
          await hub.close();
        }
        return;
      }
      die(`unknown skill subcommand "${sub}" (list|show|new|run|edit)`);
    }

    case "recipes":
    case "recipe": {
      const [sub, id] = cmd === "recipes" ? ["list"] : rest;
      if (!sub || sub === "list") {
        for (const r of Object.values(RECIPES)) {
          console.log(`${cyan(r.id.padEnd(14))} ${r.label}`);
          console.log(dim(`               ${r.description}`));
        }
        console.log(dim(`\napply: hive recipe apply <id> [--agent claude] [--alt codex] [--prefix x-] [--cwd DIR]`));
        return;
      }
      if (sub !== "apply" || !id) die("usage: hive recipe list | hive recipe apply <id> [--agent K] [--alt K]");
      const r = RECIPES[id];
      if (!r) die(`unknown recipe "${id}" (${Object.keys(RECIPES).join(", ")})`);
      const kind = values.agent ?? rest[2] ?? "claude";
      if (!AGENTS[kind]) die(`unknown agent "${kind}"`);
      if (values.alt && !AGENTS[values.alt]) die(`unknown agent "${values.alt}"`);
      const db = new HiveDb(values.db!);
      const res = applyRecipe(db, r, { cwd: resolve(values.cwd ?? process.cwd()), kind, alt: values.alt, prefix: values.prefix });
      console.log(green(`recipe ${r.id} applied`));
      for (const a of res.agents)
        console.log(`  ${cyan(a.name.padEnd(12))} ${a.kind.padEnd(8)} ${a.policy.padEnd(11)} ${a.interactive ? "you talk to it" : "automatic"}${a.worktree ? " · own worktree" : ""}`);
      if (res.groups.length) console.log(`  groups: ${res.groups.map((g) => "@" + g).join(", ")}`);
      const jobs = res.jobs.map((jid) => db.getJob(jid)!).filter(Boolean);
      for (const j of jobs) console.log(`  job #${j.id} ${j.kind} on ${j.agent}: ${schedule(j)}`);
      console.log(dim(`\nnext: ${r.next}`));
      db.close();
      return;
    }

    case "groups": {
      const db = new HiveDb(values.db!);
      const gs = db.groups();
      if (!gs.length) console.log(dim("no groups (hive group create <name> <agents…>)"));
      for (const g of gs) console.log(`${cyan("@" + g.name)}  ${g.members.join(", ")}`);
      db.close();
      return;
    }

    case "group": {
      const [sub, name, ...members] = rest;
      if (!sub || !name) die("usage: hive group create|add|rm|delete <name> [members…]");
      if (!/^[\w.-]{1,40}$/.test(name)) die(`invalid group name "${name}"`);
      const db = new HiveDb(values.db!);
      if (sub === "create" || sub === "add") {
        const unknown = members.filter((m) => m !== "owner" && !db.getAgent(m));
        if (unknown.length) die(`unknown agents: ${unknown.join(", ")} (use "owner" for yourself)`);
        if (!members.length) die("give at least one member");
        db.addToGroup(name, members);
      } else if (sub === "rm") for (const m of members) db.removeFromGroup(name, m);
      else if (sub === "delete") db.deleteGroup(name);
      else die(`unknown group subcommand "${sub}"`);
      console.log(`@${name}: ${db.groupMembers(name).join(", ") || "(deleted)"}`);
      db.close();
      return;
    }

    case "sync": {
      if (!rest[0]) die("usage: hive sync <agent-name>");
      const r = await syncWorktree(values.cwd ?? process.cwd(), rest[0]);
      (r.ok ? console.log : console.error)(r.ok ? green(r.message) : red(r.message));
      if (!r.ok) process.exitCode = 1;
      return;
    }

    case "log": {
      if (!rest[0]) die("usage: hive log <agent> [--times N]");
      const db = new HiveDb(values.db!);
      const n = values.times ? positiveInt(values.times, "--times") : 20;
      const rows = db.agentEvents(rest[0], ["prompt", "reply", "turn_end", "permission", "session"], n * 4);
      if (!rows.length) console.log(dim(`nothing logged for ${rest[0]}`));
      for (const e of rows) {
        const d = JSON.parse(e.data);
        const t = dim(new Date(e.ts).toLocaleTimeString());
        if (e.type === "prompt") console.log(`\n${t} ${cyan("›")} ${d.text.slice(0, 600)}`);
        else if (e.type === "reply") console.log(`${t} ${d.text.slice(-1500)}`);
        else if (e.type === "permission") console.log(`${t} ${yellow("🔐")} ${d.title} → ${d.decision}`);
        else if (e.type === "session") console.log(`${t} ${dim(`session ${d.how} ${d.sessionId}`)}`);
        else if (e.type === "turn_end") console.log(`${t} ${dim(`— ${d.stopReason}${d.error ? `: ${d.error}` : ""}`)}`);
      }
      db.close();
      return;
    }

    case "worktree": {
      const [sub, name] = rest;
      if (sub !== "rm" || !name) die("usage: hive worktree rm <name> [--force]");
      await removeWorktree(values.cwd ?? process.cwd(), name, { force: values.force, deleteBranch: values.force });
      console.log(`removed worktree ${name}${values.force ? " and its branch" : " (branch kept)"}`);
      return;
    }

    case "serve": {
      const hub = newHub({ wakeSleeping: true });
      const sched = new Scheduler({ hub, onJob: renderJob, closeIdleAgents: true });
      hub.run();
      sched.start();
      console.log(`hive serve: running jobs from ${resolve(values.db!)} ${dim("(Ctrl-C to stop; jobs stay queued)")}`);
      await new Promise<void>((res) => {
        let n = 0;
        const onInt = async () => {
          if (n++) process.exit(130);
          console.log(dim("\nshutting down…"));
          await sched.stop();
          await hub.close();
          res();
        };
        process.on("SIGINT", onInt);
        process.on("SIGTERM", onInt);
      });
      return;
    }

    default:
      die(`unknown command "${cmd}"\n\n${USAGE}`);
  }
}

/** Interactive chat: type while the agent works (prompts queue), Ctrl-C cancels a turn, twice to quit. */
async function chat(hub: Hub, s: AgentSession) {
  const r = getRl();
  const name = s.name;
  const showPrompt = () => {
    r.setPrompt(`${cyan(name)}> `);
    r.prompt();
  };
  console.log(
    dim(`chatting with ${name} (${s.def.label}) in ${s.cwd}. /help for commands. Ctrl-C cancels a turn; Ctrl-C when idle quits.`),
  );
  let done!: () => void;
  const finished = new Promise<void>((res) => (done = res));
  let quitting = false;
  const quit = async () => {
    if (quitting) return;
    quitting = true;
    r.close();
    await hub.close();
    done();
  };
  s.on("event", (e) => {
    if (e.type === "status" && e.status === "idle" && s.queued === 0) showPrompt();
    if (e.type === "exit") {
      console.log(red(`${name} exited; restart with \`hive chat\` to resume`));
      void quit();
    }
  });
  sigintHandler = () => {
    if (s.busyNow) {
      console.log(dim("\ncancelling…"));
      void s.cancel();
    } else void quit();
  };
  closeHandler = () => void quit();
  lineHandler = (raw) => {
    const line = raw.trim();
    if (!line) return showPrompt();
    if (line.startsWith("/")) {
      const [c, ...args] = line.slice(1).split(/\s+/);
      switch (c) {
        case "quit":
        case "exit":
          return void quit();
        case "cancel":
          void s.cancel();
          return;
        case "new":
          if (s.busyNow) console.log(dim("busy; /cancel first"));
          else void s.newSession().then(() => showPrompt());
          return;
        case "status": {
          const ctx = s.context ? `${Math.round((100 * s.context.used) / s.context.size)}% ctx` : "ctx ?";
          console.log(dim(`${s.busyNow ? "working" : "idle"} · session ${s.sessionId} · ${ctx} · ${s.queued} queued · unread ${hub.db.unreadCount(name)}`));
          return showPrompt();
        }
        case "config":
        case "model": {
          if (!args.length) {
            if (!s.configOptions.length) console.log(dim("agent exposes no config options"));
            for (const o of s.configOptions as any[])
              console.log(`  ${o.id} = ${o.currentValue}${o.options ? dim(`  [${o.options.flatMap((g: any) => g.options ?? [g]).map((x: any) => x.value).join(", ")}]`) : ""}`);
            return showPrompt();
          }
          const [id, value] = c === "model" ? ["model", args[0]] : args;
          if (!value) {
            console.log(dim("usage: /config <id> <value>"));
            return showPrompt();
          }
          void s
            .setConfigOption(id, value === "true" ? true : value === "false" ? false : value)
            .then(() => console.log(dim(`${id} → ${value}`)))
            .catch((e) => console.log(red(String(e?.message ?? e))))
            .finally(showPrompt);
          return;
        }
        case "help":
          console.log(dim("/quit  /cancel  /new (fresh session)  /status  /model <id>  /config [<id> <value>]"));
          return showPrompt();
        default:
          console.log(dim(`unknown command /${c} (try /help)`));
          return showPrompt();
      }
    }
    void s.prompt(line).catch((e) => console.log(red(String(e?.message ?? e))));
  };
  showPrompt();
  await finished;
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error(red(String(e?.stack ?? e)));
    process.exit(1);
  },
);
