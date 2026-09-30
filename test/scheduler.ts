/**
 * Phase 2 acceptance: the scheduler, with the mock agent.
 *   - loop --times 3 → 3 turn_end events, 3 job_runs rows, 3 fresh sessions,
 *     notes file carried across iterations
 *   - watch fires after 60 changed lines, not after 10
 *   - interval / once / until / stop / leases
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hub } from "../src/core/hub.js";
import { Scheduler, parseDuration, formatDuration, type JobEvent } from "../src/core/scheduler.js";
import type { SessionEvent } from "../src/core/session.js";
import { assert, finish, freshDir, sleep, until } from "./util.js";

const dir = freshDir(".hive-test-scheduler");
const dbPath = join(dir, "hive.db");
const work = freshDir(join(dir, "work"));

const log: { agent: string; e: SessionEvent }[] = [];
const jobLog: JobEvent[] = [];
const hub = new Hub({
  hiveDb: dbPath,
  pollMs: 200,
  onEvent: (agent, e) => {
    log.push({ agent, e });
    if (e.type === "status" && e.status === "error") console.error(`[${agent}] ERROR ${e.note}`);
  },
});
const sched = new Scheduler({
  hub,
  tickMs: 100,
  watchDebounceMs: 150,
  retryMs: 200,
  closeIdleAgents: true,
  onJob: (e) => {
    jobLog.push(e);
    if (e.type === "error") console.error(`[job ${e.job.id}] ${e.error}`);
  },
});
sched.start();

// ---- loop --times 3 ----
const loopId = hub.db.addJob({ agent: "hunter", agent_kind: "mock", cwd: work, prompt: "hunt bugs", kind: "loop", remaining: 3, policy: "allow-all" });
await until(() => hub.db.getJob(loopId)?.enabled === 0, 30_000, "loop job to finish");
const turnEnds = log.filter((l) => l.agent === "hunter" && l.e.type === "turn_end");
const runs = hub.db.jobRuns(loopId);
assert(turnEnds.length === 3, `loop --times 3 → 3 turn_end events (${turnEnds.length})`);
assert(runs.length === 3 && runs.every((r) => r.ended && r.stop_reason === "end_turn"), `3 job_runs rows, all end_turn (${runs.length})`);
assert(new Set(runs.map((r) => r.session_id)).size === 3, "each iteration ran in a fresh ACP session");
assert(runs.every((r) => r.usage && JSON.parse(r.usage).totalTokens === 100), "usage recorded on job_runs");
const job = hub.db.getJob(loopId)!;
assert(job.ended_reason === "done" && job.remaining === 0 && job.runs === 3, "loop job ended 'done' with remaining 0");
const notes = join(work, ".hive", "notes", `job-${loopId}.md`);
const notesText = existsSync(notes) ? readFileSync(notes, "utf8") : "";
assert((notesText.match(/- iteration by/g) ?? []).length === 3, "notes file accumulated one entry per iteration");
const prompts = hub.db
  .events(0, 10_000)
  .filter((e) => e.agent === "hunter" && e.type === "prompt")
  .map((e) => JSON.parse(e.data).text as string);
assert(prompts.some((p) => p.includes("iteration 3 of 3")), "prompt tells the agent which iteration it is");
await until(() => !hub.sessions.has("hunter"), 5000, "scheduler to close its idle agent");
assert(!hub.sessions.has("hunter"), "agent started for the job is closed when the job ends");

// ---- watch: 10 lines no, 60 lines yes ----
writeFileSync(join(work, "existing.ts"), "export const a = 1;\n");
const watchId = hub.db.addJob({
  agent: "guard",
  agent_kind: "mock",
  cwd: work,
  prompt: "security review the changes",
  kind: "watch",
  watch_path: work,
  watch_min_lines: 50,
  policy: "allow-reads",
});
await until(() => !!hub.db.getJob(watchId)?.watch_ref, 10_000, "watch baseline");
const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `const ${tag}${i} = ${i};`).join("\n") + "\n";
writeFileSync(join(work, "new.ts"), lines(10, "x"));
await until(() => jobLog.some((e) => e.type === "watch" && e.job.id === watchId && e.lines === 10), 10_000, "10-line recount");
await sleep(600);
assert(hub.db.jobRuns(watchId).length === 0, "watch does not fire after 10 changed lines");
appendFileSync(join(work, "new.ts"), lines(50, "y"));
await until(() => hub.db.jobRuns(watchId).some((r) => r.ended), 15_000, "watch run");
const wr = hub.db.jobRuns(watchId);
assert(wr.length === 1, `watch fires once after 60 changed lines (${wr.length})`);
const watchPrompt = hub.db
  .events(0, 10_000)
  .filter((e) => e.agent === "guard" && e.type === "prompt")
  .map((e) => JSON.parse(e.data).text as string)
  .pop();
assert(watchPrompt && /60 changed lines in 1 file/.test(watchPrompt) && /new\.ts/.test(watchPrompt), "watch prompt lists what changed");
const ref1 = hub.db.getJob(watchId)!.watch_ref;
writeFileSync(join(work, "new.ts"), readFileSync(join(work, "new.ts"), "utf8") + lines(5, "z"));
await sleep(800);
assert(hub.db.jobRuns(watchId).length === 1, "baseline moved after firing: 5 more lines don't re-fire");
assert(ref1 && hub.db.getJob(watchId)!.watch_ref === ref1, "watch_ref stored after firing");
// ignored dirs don't count
writeFileSync(join(work, ".hive", "junk.txt"), lines(100, "j"));
await sleep(800);
assert(hub.db.jobRuns(watchId).length === 1, ".hive/ changes are ignored");
hub.db.endJob(watchId, "stopped");

// ---- interval ----
const ivId = hub.db.addJob({ agent: "scout", agent_kind: "mock", cwd: work, prompt: "find features", kind: "interval", every_ms: 700, policy: "allow-reads" });
await until(() => hub.db.jobRuns(ivId).length >= 2, 10_000, "two interval runs");
const iv = hub.db.jobRuns(ivId).reverse();
assert(iv[1].started - iv[0].started >= 600, `interval runs spaced by every_ms (${iv[1].started - iv[0].started} ms)`);
hub.db.endJob(ivId, "stopped");

// ---- once, in the future ----
const onceId = hub.db.addJob({ agent: "scout", agent_kind: "mock", cwd: work, prompt: "once", kind: "once", next_run: Date.now() + 500 });
await sleep(200);
assert(hub.db.jobRuns(onceId).length === 0, "once job waits for next_run");
await until(() => hub.db.getJob(onceId)?.enabled === 0, 10_000, "once job");
assert(hub.db.jobRuns(onceId).length === 1 && hub.db.getJob(onceId)!.ended_reason === "done", "once job runs exactly once");

// ---- until_ts ----
const untilId = hub.db.addJob({ agent: "scout", agent_kind: "mock", cwd: work, prompt: "loop till", kind: "loop", until_ts: Date.now() + 1500 });
await until(() => hub.db.getJob(untilId)?.enabled === 0, 15_000, "until job");
assert(hub.db.getJob(untilId)!.ended_reason === "until" && hub.db.jobRuns(untilId).length >= 1, "loop --hours stops at until_ts");

// ---- stop mid-run cancels the turn ----
const stopId = hub.db.addJob({ agent: "slowpoke", agent_kind: "mock", cwd: work, prompt: "be slow", kind: "loop", remaining: 5 });
await until(() => hub.db.jobRuns(stopId).length === 1, 10_000, "slow run to start");
const t0 = Date.now();
hub.db.endJob(stopId, "stopped");
await until(() => hub.db.jobRuns(stopId)[0]?.ended != null, 8000, "stopped run to end");
assert(Date.now() - t0 < 5000 && hub.db.jobRuns(stopId)[0].stop_reason === "cancelled", "job stop cancels the in-flight turn");
assert(hub.db.jobRuns(stopId).length === 1, "stopped job does not run again");

// ---- leases: a second scheduler can't take a job we own ----
const other = new Scheduler({ hub, tickMs: 100, owner: "other" });
const leaseId = hub.db.addJob({ agent: "scout", agent_kind: "mock", cwd: work, prompt: "lease", kind: "interval", every_ms: 60_000, next_run: Date.now() + 60_000 });
await sched.tick();
const claimedByOther = hub.db.claimJobs("other", 30_000).some((j) => j.id === leaseId);
assert(!claimedByOther && hub.db.getJob(leaseId)!.owner === sched.owner, "job leases keep two schedulers apart");
await other.stop();
hub.db.endJob(leaseId, "stopped");

// ---- failing agent: backoff, then 'failed' ----
const badId = hub.db.addJob({ agent: "ghost", agent_kind: "nope", cwd: work, prompt: "x", kind: "loop", remaining: 3 });
await until(() => hub.db.getJob(badId)?.enabled === 0, 15_000, "bad job to fail");
assert(hub.db.getJob(badId)!.ended_reason === "failed" && /could not start/.test(hub.db.getJob(badId)!.last_error ?? ""), "unstartable agent ends job as failed with error");

// ---- durations ----
assert(parseDuration("10m") === 600_000 && parseDuration("1h30m") === 5_400_000 && parseDuration("500ms") === 500, "parseDuration");
let threw = false;
try {
  parseDuration("10");
} catch {
  threw = true;
}
assert(threw, "parseDuration rejects unitless numbers");
assert(formatDuration(5_400_000) === "1h30m", "formatDuration");

await sched.stop();
await hub.close();
finish("scheduler");
