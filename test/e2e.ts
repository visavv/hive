/**
 * End-to-end: two mock agents talk through the hive.
 *   1. alice is told "send bob: review auth"  → hive_send
 *   2. hub delivery loop wakes bob → bob reads inbox, replies "re: task"
 *   3. hub wakes alice → alice reads the reply
 *   4. permission policy: allow-all lets an edit through; reject-all blocks it
 */
import { rmSync, mkdirSync } from "node:fs";
import { Hub } from "../src/core/hub.js";
import { AGENTS } from "../src/core/agents.js";
import type { SessionEvent } from "../src/core/session.js";

const dir = ".hive-test";
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const dbPath = `${dir}/hive.db`;

const log: { agent: string; e: SessionEvent }[] = [];
const hub = new Hub({
  hiveDb: dbPath,
  pollMs: 300,
  onEvent: (agent, e) => {
    log.push({ agent, e });
// This test is about raw mail delivery between unlinked allow-all agents (the guard has its own test in links.ts).
hub.db.setGuardAllowAll(false);
    if (e.type === "text") process.stdout.write(`[${agent}] ${e.text}`);
    if (e.type === "tool_call" && e.status === "pending") console.log(`[${agent}] ⚙ ${e.title}`);
    if (e.type === "permission") console.log(`[${agent}] 🔐 ${e.title} → ${e.decision}`);
    if (e.type === "status" && e.status === "error") console.error(`[${agent}] ERROR ${e.note}`);
  },
});

function mockWithName(name: string) {
  return { ...AGENTS.mock, env: { ...(AGENTS.mock.env ?? {}), MOCK_NAME: name } };
}

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error(`\n❌ ${msg}`);
    process.exitCode = 1;
  } else console.log(`✅ ${msg}`);
}

const t0 = Date.now();
const alice = await hub.add({ name: "alice", agent: mockWithName("alice"), cwd: process.cwd(), role: "coder", policy: "allow-all" });
const bob = await hub.add({ name: "bob", agent: mockWithName("bob"), cwd: process.cwd(), role: "reviewer", policy: "reject-all" });
console.log(`agents up in ${Date.now() - t0}ms\n`);
hub.run();

await alice.prompt("agents? then send bob: please review the auth module");
await hub.settle(30_000);

const msgs = hub.db.db.prepare("SELECT from_agent, to_agent, subject FROM messages ORDER BY id").all() as any[];
console.log("\nmessages:", msgs);
assert(msgs.some((m) => m.from_agent === "alice" && m.to_agent === "bob" && m.subject === "task"), "alice → bob task delivered");
assert(msgs.some((m) => m.from_agent === "bob" && m.to_agent === "alice" && m.subject === "re: task"), "bob replied to alice");
assert(hub.db.unreadCount("alice") === 0 && hub.db.unreadCount("bob") === 0, "all mail read (hub woke both agents)");
assert(log.some((l) => l.agent === "alice" && l.e.type === "text" && /Got mail from bob/.test(l.e.text)), "alice saw bob's reply in her turn");

await alice.prompt("please edit something; bb build=green");
await bob.prompt("please edit something");
await hub.settle(30_000);
assert(log.some((l) => l.agent === "alice" && l.e.type === "permission" && l.e.decision === "allow_once"), "allow-all policy auto-approved alice's edit");
assert(log.some((l) => l.agent === "bob" && l.e.type === "permission" && l.e.decision === "reject_once"), "reject-all policy blocked bob's edit");
assert(hub.db.bbGet("build")?.value === "green", "blackboard write visible from hub");
assert(log.some((l) => l.e.type === "turn_end" && (l.e as any).usage?.totalTokens === 100), "usage surfaced on turn_end");

const agents = hub.db.listAgents();
console.log("\nagents:", agents.map((a) => `${a.name}/${a.kind}/${a.status}:${a.status_note}`));

await hub.close();
console.log(process.exitCode ? "\nFAILED" : "\nALL PASSED");
process.exit(process.exitCode ?? 0);
