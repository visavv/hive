/** ✦ improve: a rough draft becomes a full prompt for the same agent, without entering its conversation. */
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { assert, finish, freshDir } from "./util.js";
import { buildImproveRequest, extractPrompt } from "../src/core/improve.js";

assert(extractPrompt("Sure:\n```text\nDo the thing.\nThen test.\n```\nnotes") === "Do the thing.\nThen test." && extractPrompt("plain reply") === "plain reply", "the prompt is taken from the fenced block (or the whole reply)");
const req = buildImproveRequest({ draft: "fix it", agent: "coder", kind: "claude", role: "coder", cwd: "/x", chat: [{ who: "you", text: "the login bug" }] });
assert(req.includes("The owner's draft:\n<<<\nfix it\n>>>") && req.includes("OWNER: the login bug") && /must not do the task yourself/.test(req), "the request carries the draft, the recent chat and 'don't do the task'");

const dir = freshDir(".hive-test-improve");
process.env.HIVE_HOME = join(dir, "home");
const work = join(dir, "work");
freshDir(".hive-test-improve/work");
execFileSync("git", ["init", "-q"], { cwd: work });
const { Hub } = await import("../src/core/hub.js");
const { improvePrompt, helperName } = await import("../src/core/improve.js");
const { stats } = await import("../src/core/ledger.js");
const hub = new Hub({ hiveDb: join(dir, "hive.db"), pollMs: 200 });
const coder = await hub.add({ name: "coder", agent: "mock", cwd: work, policy: "allow-all" });
await coder.runOnce("the login form forgets the email after an error", { automatic: false });
const before = (hub.db.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE agent='coder' AND type='prompt'`).get() as { n: number }).n;

const out = await improvePrompt(hub, "coder", "make it remember the email");
assert(out.startsWith("IMPROVED: make it remember the email"), `the improved prompt comes back (${out.slice(0, 60)})`);
assert(out.includes("Context seen: the login form forgets the email after an error"), "the helper saw the agent's recent conversation");
const after = (hub.db.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE agent='coder' AND type='prompt'`).get() as { n: number }).n;
assert(after === before, "nothing was sent to the agent itself: its conversation is untouched");
assert(hub.sessions.get(helperName("coder"))?.def.id === "mock", "the helper is the same agent type (same subscription)");
assert(stats("category").rows.some((r) => r.key === "prompting"), "helper turns count as 'prompting' in token stats");

let threw = "";
try {
  await improvePrompt(hub, "coder", "   ");
} catch (e: any) {
  threw = e.message;
}
assert(/rough prompt first/.test(threw), "an empty draft is refused");
await hub.close();
finish("improve");
