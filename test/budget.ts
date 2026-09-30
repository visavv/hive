/** Usage tracking, provider limit windows, and spending guards for automatic work. */
import { join } from "node:path";
import { Hub } from "../src/core/hub.js";
import { Scheduler, type JobEvent } from "../src/core/scheduler.js";
import { checkAutomatic, usageSummary } from "../src/core/budget.js";
import { assert, finish, freshDir, sleep, until } from "./util.js";

const dir = freshDir(".hive-test-budget");
const hub = new Hub({ hiveDb: join(dir, "hive.db"), pollMs: 200 });
const db = hub.db;
const a = await hub.add({ name: "worker", agent: "mock", cwd: dir, policy: "allow-all" });

await a.prompt("hello ratelimit-meta 42");
await a.prompt("again");
const u1 = usageSummary(db);
const mockP = u1.providers.find((p) => p.provider === "mock")!;
assert(mockP.d1 === 200 && mockP.h5 === 200, `tokens per provider recorded per turn (${mockP.d1})`);
assert(Math.abs(mockP.cost7 - 0.02) < 1e-9, `cost deltas from usage_update summed (${mockP.cost7})`);
const w = mockP.limits.find((l) => l.window === "five_hour")!;
assert(w && Math.round(w.pct!) === 42 && w.resetsAt! > Date.now() + 3_500_000, "rate-limit window (utilization + reset) captured from the adapter's _meta");
assert(db.usageSince(0, true).length === 0, "your own prompts are not counted as automatic");

// reserve: window 90% full → automatic work held until the reset; your prompts still run
await a.prompt("ratelimit-meta 90");
let g = checkAutomatic(db, "mock");
assert(!g.ok && /five_hour window at 90%/.test(g.reason) && g.until! > Date.now(), "subscription reserve holds automatic work at 85% (default)");
db.setSetting("budget.reserve_pct", "95");
assert(checkAutomatic(db, "mock").ok, "reserve_pct is configurable");
db.setLimit("mock", "five_hour", { utilization: 0.99, resets_at: Math.floor(Date.now() / 1000) - 10 });
assert(checkAutomatic(db, "mock").ok, "a window that already reset doesn't block");

// daily budget: jobs held (paused event + one owner mail), mail wake-ups held, typed prompts still run
db.setSetting("budget.daily_tokens", "250");
g = checkAutomatic(db, "mock");
assert(!g.ok && /daily token budget reached/.test(g.reason), "daily token budget reached");
const events: JobEvent[] = [];
const sched = new Scheduler({ hub, tickMs: 100, onJob: (e) => events.push(e) });
sched.start();
const jid = db.addJob({ agent: "worker", agent_kind: "mock", cwd: dir, kind: "loop", remaining: 2, prompt: "work" });
await until(() => events.some((e) => e.type === "paused" && e.job.id === jid), 5000, "held");
await sleep(500);
assert(db.jobRuns(jid).length === 0 && /held: daily token budget/.test(db.getJob(jid)!.last_error ?? ""), "jobs don't run over budget and say why");
const notes = db.inbox("owner", true).filter((m) => m.subject === "automatic work held back");
assert(notes.length === 1, "the owner is told once (UI inbox / chat bridges)");
db.send("owner", "worker", "task", "do it");
hub.run();
await sleep(1500);
assert(db.unreadCount("worker") === 1, "mail wake-ups are held over budget");
await a.prompt("typed by the human");
assert(true, "prompts you type still run over budget");

// raising the budget releases the job
db.setSetting("budget.daily_tokens", null);
await until(() => db.jobRuns(jid).length >= 1, 10_000, "released");
assert(true, "raising the budget releases held jobs");
await until(() => db.getJob(jid)?.enabled === 0, 15_000, "job done");

// max_concurrent
db.setSetting("budget.max_concurrent", "1");
const j1 = db.addJob({ agent: "slow1", agent_kind: "mock", cwd: dir, kind: "once", prompt: "be slow" });
const j2 = db.addJob({ agent: "slow2", agent_kind: "mock", cwd: dir, kind: "once", prompt: "be slow" });
await until(() => db.jobRuns(j1).length + db.jobRuns(j2).length >= 1, 10_000, "one started");
await sleep(1500);
assert(db.jobRuns(j1).length + db.jobRuns(j2).length === 1, "max_concurrent caps automatic runs");
db.endJob(j1, "stopped");
db.endJob(j2, "stopped");

// pause switch
db.setSetting("budget.paused", "1");
assert(!checkAutomatic(db, "mock").ok, "budget paused=1 stops all automatic work");

await sched.stop();
await hub.close();
finish("budget");
