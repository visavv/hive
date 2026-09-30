/**
 * Session features added after phase 1: cancel via ClientContext, resume on
 * restart (session/resume and session/load), elicitation, mail-wake prompt
 * with count + senders, fresh sessions, config options, context %.
 */
import { Hub } from "../src/core/hub.js";
import type { SessionEvent } from "../src/core/session.js";
import { assert, finish, freshDir, mock, until } from "./util.js";

const dir = freshDir(".hive-test-session");
const dbPath = `${dir}/hive.db`;
const log: { agent: string; e: SessionEvent }[] = [];
const onEvent = (agent: string, e: SessionEvent) => {
  log.push({ agent, e });
  if (e.type === "status" && e.status === "error") console.error(`[${agent}] ERROR ${e.note}`);
};
const texts = (agent: string) =>
  log.filter((l) => l.agent === agent && l.e.type === "text").map((l) => (l.e as any).text as string).join("");

// ---- cancel, elicitation, config, context ----
let hub = new Hub({ hiveDb: dbPath, pollMs: 200, onEvent });
const carol = await hub.add({
  name: "carol",
  agent: mock("carol"),
  cwd: process.cwd(),
  policy: "allow-all",
  elicit: async (req) => ({ action: "accept", content: { answer: `42 for ${req.message.length > 0}` } }),
});
const dave = await hub.add({ name: "dave", agent: mock("dave"), cwd: process.cwd(), policy: "allow-all" });

const t0 = Date.now();
const slow = carol.runOnce("be slow please");
await until(() => texts("carol").includes("working slowly"), 5000, "slow turn to start");
await carol.cancel();
const r = await slow;
assert(r.stopReason === "cancelled" && Date.now() - t0 < 5000, `cancel() stops a turn via session/cancel (${r.stopReason})`);

await carol.prompt("ask? something");
assert(/elicit: accept \{"answer":"42 for true"\}/.test(texts("carol")), "elicitation forwarded to handler and answered");
await dave.prompt("ask? something");
assert(/elicit: decline/.test(texts("dave")), "elicitation declined when no handler");

assert(carol.configOptions[0]?.id === "model", "configOptions from session/new exposed");
await carol.setConfigOption("model", "mock-large");
assert(carol.configOptions[0] && (carol.configOptions[0] as any).currentValue === "mock-large", "setConfigOption round-trips");
assert(carol.context?.size === 200_000 && carol.context.used > 0, "context usage (ctx %) tracked from usage_update");

await until(() => !!carol.authStatus, 3000, "auth push");
assert(carol.authStatus?.kind === "mock" && log.some((l) => l.e.type === "auth" && l.e.label === "Mock login"), "_auth/status_update captured as auth event");

// ---- mail-wake prompt includes count + senders ----
hub.db.send("dave", "carol", "first", "a");
hub.db.send("dave", "carol", "second", "b");
hub.db.send("eve", "carol", "third", "c");
hub.run();
await hub.settle(20_000);
const wake = hub.db
  .events(0, 10_000)
  .filter((e) => e.agent === "carol" && e.type === "prompt")
  .map((e) => JSON.parse(e.data).text as string)
  .find((t) => t.startsWith("You have"));
assert(
  wake && /3 unread hive messages/.test(wake) && /2 from dave \("first", "second"\)/.test(wake) && /1 from eve/.test(wake),
  `wake prompt lists count and senders: ${wake}`,
);

// ---- fresh session ----
const before = carol.sessionId;
await carol.newSession();
assert(carol.sessionId && carol.sessionId !== before, "newSession() opens a fresh ACP session on the same process");
assert(hub.db.getAgent("carol")?.session_id === carol.sessionId, "agents table tracks the current session id");

// ---- resume on hub restart (session/resume) ----
const sid = carol.sessionId!;
await hub.close();
hub = new Hub({ hiveDb: dbPath, pollMs: 200, onEvent });
const carol2 = await hub.add({ name: "carol", agent: mock("carol"), cwd: process.cwd(), policy: "allow-all", resume: true });
assert(carol2.sessionId === sid, "hub restart resumes the stored session id");
assert(log.some((l) => l.agent === "carol" && l.e.type === "session" && l.e.how === "resumed"), "resume used session/resume");
await carol2.prompt("hello again");
assert(texts("carol").includes(`(resumed session ${sid})`), "agent saw the resumed session");
await hub.remove("carol", false);

// ---- resume via session/load (agent without session/resume) ----
const n = log.length;
const carol3 = await hub.add({
  name: "carol",
  agent: mock("carol", { MOCK_NO_RESUME: "1" }),
  cwd: process.cwd(),
  policy: "allow-all",
  resume: true,
});
assert(carol3.sessionId === sid, "session/load fallback keeps the session id");
assert(
  !log.slice(n).some((l) => l.e.type === "text" && l.e.text.includes("replayed history")),
  "replayed history from session/load is not re-emitted",
);
await hub.remove("carol", false);

// ---- different cwd → no resume ----
const carol4 = await hub.add({ name: "carol", agent: mock("carol"), cwd: dir, policy: "allow-all", resume: true });
assert(carol4.sessionId !== sid, "no resume when cwd changed");


// ---- a broken agent with unread mail must not spin ----
const broken = await hub.add({ name: "broken", agent: mock("broken", { MOCK_FAIL: "1" }), cwd: process.cwd(), policy: "allow-all" });
hub.db.send("carol", "broken", "hi", "x");
hub.run();
await new Promise((r) => setTimeout(r, 3000));
const tries = hub.db.events(0, 100_000).filter((e) => e.agent === "broken" && e.type === "prompt").length;
assert(tries >= 1 && tries <= 2, `failing wake-ups back off instead of spinning (${tries} tries in 3 s)`);
await hub.remove("broken");

// ---- cancel answers a pending permission ask with "cancelled" ----
let asked = false;
const waiter = await hub.add({
  name: "waiter",
  agent: mock("waiter"),
  cwd: process.cwd(),
  policy: "ask",
  askPermission: () => {
    asked = true;
    return new Promise<string>(() => {}); // nobody answers
  },
});
const turn = waiter.runOnce("please edit something");
await until(() => asked, 5000, "permission ask");
await waiter.cancel();
const tr = await Promise.race([turn, new Promise<null>((r) => setTimeout(() => r(null), 5000))]);
assert(tr && log.some((l) => l.agent === "waiter" && l.e.type === "permission" && l.e.decision === "cancelled"), "cancel() resolves a pending permission as cancelled and the turn ends");
assert(texts("waiter").includes("edit rejected"), "agent saw the cancelled permission as not allowed");

// ---- two fresh runs racing on one agent stay serialized ----
const racer = await hub.add({ name: "racer", agent: mock("racer"), cwd: process.cwd(), policy: "allow-all" });
const sessions = new Set<string>();
racer.on("event", (e) => e.type === "session" && sessions.add(e.sessionId));
const [a, b] = await Promise.all([racer.runOnce("one", { fresh: true }), racer.runOnce("two", { fresh: true })]);
assert(a.sessionId && b.sessionId && a.sessionId !== b.sessionId && sessions.size === 1, "concurrent fresh runs get their own sessions, no orphans");

// ---- one process per agent name ----
const other = new Hub({ hiveDb: dbPath });
let elsewhere = "";
await other.add({ name: "racer", agent: mock("racer"), cwd: process.cwd() }).catch((e) => (elsewhere = e.message));
assert(/already running in another hive process/.test(elsewhere), "a second process can't start an agent that is already running");
await hub.remove("racer", false);
const moved = await other.add({ name: "racer", agent: mock("racer"), cwd: process.cwd() });
assert(!!moved.sessionId, "after the first process releases it, another process can take the agent");
await other.close();

// ---- late joiners don't inherit old broadcasts ----
hub.db.send("dave", "*", "old news", "before newbie joined");
await new Promise((r) => setTimeout(r, 5));
const newbie = await hub.add({ name: "newbie", agent: mock("newbie"), cwd: process.cwd() });
assert(hub.db.unreadCount("newbie") === 0, "broadcasts sent before an agent joined are not its mail");
hub.db.send("dave", "*", "fresh news", "after");
assert(hub.db.unreadCount("newbie") === 1, "broadcasts after joining are");
void newbie;

// ---- an agent that ignores its mail: budget + growing backoff, via the hub's poke loop ----
const deaf = await hub.add({ name: "deaf", agent: mock("deaf", { MOCK_DEAF: "1" }), cwd: process.cwd(), maxWakesPer10Min: 2 });
hub.db.send("carol", "deaf", "hello", "x");
await new Promise((r) => setTimeout(r, 7000));
const deafPrompts = hub.db.events(0, 100_000).filter((e) => e.agent === "deaf" && e.type === "prompt").length;
assert(deafPrompts >= 1 && deafPrompts <= 2, `ignored mail: wake-ups limited by backoff and budget (${deafPrompts} in 7 s)`);
// the human's own prompts are not held back by the mail backoff
void deaf.prompt("hello human prompt");
await until(() => hub.db.events(0, 100_000).some((e) => e.agent === "deaf" && e.type === "prompt" && JSON.parse(e.data).text === "hello human prompt"), 8000, "typed prompt").catch(() => {});
assert(hub.db.events(0, 100_000).some((e) => e.agent === "deaf" && e.type === "prompt" && JSON.parse(e.data).text === "hello human prompt"), "typed prompts run even while mail delivery is backed off");

// ---- hive's own MCP tools never need a human, even under "ask" ----
await deaf.prompt("hivetool please");
await until(() => texts("deaf").includes("hive tool"), 8000, "hive tool").catch(() => {});
assert(texts("deaf").includes("hive tool allowed"), "hive MCP tool calls are auto-allowed under any policy but reject-all");

// ---- failed start leaves no ghost agent row ----
await hub.add({ name: "ghosty", agent: { ...mock("ghosty"), command: "/nonexistent/binary", args: [] }, cwd: process.cwd(), startTimeoutMs: 5000 }).catch(() => {});
assert(!hub.db.getAgent("ghosty"), "a failed start doesn't leave a ghost agent in the hive");

// ---- owner mail excludes agent broadcasts; prune never resurrects read broadcasts ----
const ownerBefore = hub.db.unreadCount("owner");
hub.db.send("carol", "*", "chatter", "for agents");
assert(hub.db.unreadCount("owner") === ownerBefore, "agent broadcasts are not owner mail");
hub.db.markRead(hub.db.inbox("dave").map((m) => m.id), "dave");
const daveUnread = hub.db.unreadCount("dave");
hub.db.db.prepare("UPDATE message_reads SET read_at = read_at - 40*86400000").run();
hub.db.prune(30);
assert(hub.db.unreadCount("dave") === daveUnread, "pruning old events doesn't make read broadcasts unread again");

// ---- a hub with wakeSleeping starts an agent that has mail but isn't running ----
const sl = await hub.add({ name: "sleeper", agent: "mock", cwd: process.cwd(), policy: "allow-all" });
const slSession = sl.sessionId;
await hub.remove("sleeper", false);
hub.db.send("owner", "sleeper", "overnight task", "please do it");
const waker = new Hub({ hiveDb: dbPath, pollMs: 200, wakeSleeping: true, onEvent });
waker.run();
await until(() => hub.db.unreadCount("sleeper") === 0, 20_000, "sleeper woken").catch(() => {});
assert(hub.db.unreadCount("sleeper") === 0, "serve-style hub wakes a sleeping agent to deliver its mail");
assert(waker.sessions.get("sleeper")?.sessionId === slSession, "the woken agent resumed its previous session");
await waker.close();

await hub.close();
finish("session");
