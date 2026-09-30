/** Groups (@name mail), agent-made groups, follow-ups, review triggers (cooldown, max-wait, blackboard). */
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { Hub } from "../src/core/hub.js";
import { Scheduler } from "../src/core/scheduler.js";
import { BB_PREFIX } from "../src/core/watch.js";
import { RECIPES, applyRecipe } from "../src/core/recipes.js";
import type { SessionEvent } from "../src/core/session.js";
import { assert, finish, freshDir, mock, sleep, until } from "./util.js";

const dir = freshDir(".hive-test-groups");
const work = freshDir(join(dir, "work"));
const log: { agent: string; e: SessionEvent }[] = [];
const hub = new Hub({ hiveDb: join(dir, "hive.db"), pollMs: 200, onEvent: (agent, e) => log.push({ agent, e }) });
const texts = (a: string) => log.filter((l) => l.agent === a && l.e.type === "text").map((l) => (l.e as any).text).join("");

const a = await hub.add({ name: "ana", agent: mock("ana"), cwd: work, policy: "allow-all" });
await hub.add({ name: "ben", agent: mock("ben"), cwd: work, policy: "allow-all" });
await hub.add({ name: "cid", agent: mock("cid"), cwd: work, policy: "allow-all" });

// agent creates a group with a tool call, then mails it
await a.prompt("grp create dev ben");
assert(hub.db.groupMembers("dev").join(",") === "ana,ben", `agent-created group includes creator and members (${hub.db.groupMembers("dev")})`);
await a.prompt("send @dev: standup at 10");
assert(hub.db.unreadCount("ben") === 1 && hub.db.unreadCount("cid") === 0 && hub.db.unreadCount("ana") === 0, "group mail reaches members only (not the sender)");
assert(hub.db.unreadSummary("ben")[0]?.from === "ana via @dev", "wake-up says which group the mail came through");
hub.run();
await hub.settle(20_000);
assert(hub.db.unreadCount("ben") === 0 && texts("ben").includes("Got mail from ana"), "member was woken and read the group mail");
hub.db.addToGroup("dev", ["cid"]);
hub.db.send("owner", "@dev", "hi team", "from the human");
assert(hub.db.unreadCount("cid") === 1 && hub.db.unreadCount("ana") === 1, "owner can mail a group; read state is per member");
await hub.settle(20_000);
let bad = "";
await a.prompt("send @nope: x");
bad = texts("ana");
assert(/No group "@nope"/.test(bad), "mail to an unknown group is refused with the list of groups");

// follow-up: an agent schedules a one-off turn for another agent
await a.prompt("followup 5 for ben: re-check the build");
const fu = hub.db.listJobs(false).find((j) => j.kind === "once" && j.agent === "ben");
assert(fu && fu.fresh_session === 0 && fu.next_run > Date.now() + 4 * 60_000 && /follow-up from ana/.test(fu.prompt), "hive_followup schedules a once job for the target, keeping its context");
hub.db.endJob(fu!.id, "stopped");

// ---- triggers ----
const sched = new Scheduler({ hub, tickMs: 100, watchDebounceMs: 100, branchPollMs: 100 });
sched.start();

// blackboard trigger with cooldown
const bbJob = hub.db.addJob({ agent: "polisher", agent_kind: "mock", cwd: work, kind: "watch", watch_path: BB_PREFIX + "ideas/raw/", prompt: "polish new ideas", cooldown_ms: 2500 });
await until(() => hub.db.getJob(bbJob)?.watch_ref != null, 5000, "bb baseline");
hub.db.bbSet("ideas/raw/dark-mode", "add dark mode", "scout");
await until(() => hub.db.jobRuns(bbJob).some((r) => r.ended), 10_000, "bb run");
const bbPrompt = hub.db.events(0, 100000).filter((e) => e.agent === "polisher" && e.type === "prompt").map((e) => JSON.parse(e.data).text).pop() ?? "";
assert(/ideas\/raw\/dark-mode/.test(bbPrompt) && /add dark mode/.test(bbPrompt), "blackboard trigger fires on a new entry and lists it");
hub.db.bbSet("ideas/raw/shorts", "clip ideas", "scout");
await sleep(1200);
assert(hub.db.jobRuns(bbJob).length === 1, "cooldown holds the next review back");
await until(() => hub.db.jobRuns(bbJob).length === 2, 10_000, "bb after cooldown");
assert(true, "after the cooldown the new entry is reviewed");
hub.db.endJob(bbJob, "stopped");

// folder watch: few lines, but max-wait makes it fire anyway
const tw = hub.db.addJob({ agent: "rev", agent_kind: "mock", cwd: work, kind: "watch", watch_path: work, watch_min_lines: 50, every_ms: 1500, prompt: "review" });
await until(() => !!hub.db.getJob(tw)?.watch_ref, 5000, "tree baseline");
writeFileSync(join(work, "small.ts"), "a\nb\nc\n");
await sleep(700);
assert(hub.db.jobRuns(tw).length === 0, "3 lines don't reach min-lines");
await until(() => hub.db.jobRuns(tw).length === 1, 10_000, "max-wait run");
assert(true, "max-wait: any change is reviewed after the time limit");

await sched.stop();

// ---- recipes ----
const r1 = applyRecipe(hub.db, RECIPES["solid-code"], { cwd: work, kind: "claude", alt: "codex" });
assert(r1.agents.map((a) => `${a.name}:${a.kind}`).join(",") === "coder:claude,tester:codex,improver:codex", "recipe creates its team (alt vendor for checkers)");
assert(hub.db.groupMembers("dev").includes("tester") && hub.db.groupMembers("dev").includes("owner"), "recipe groups include the owner");
assert(r1.jobs.length === 2 && hub.db.getAgent("tester")?.briefing?.includes("scratch copy"), "recipe jobs + stored briefing for non-preset agents");
const r2 = applyRecipe(hub.db, RECIPES["solid-code"], { cwd: work, kind: "claude", alt: "codex" });
assert(r2.jobs.length === 0, "re-applying a recipe doesn't duplicate its jobs");
const r3 = applyRecipe(hub.db, RECIPES["idea-pipeline"], { cwd: work, kind: "mock", prefix: "yt-" });
assert(r3.agents[0].name === "yt-scout" && hub.db.groupMembers("yt-ideas").join(",") === "owner,yt-polisher,yt-scout", "prefix namespaces a second copy of a recipe");

await hub.close();
finish("groups");
