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

await hub.close();
finish("session");
