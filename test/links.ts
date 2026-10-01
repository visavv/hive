/** The layer between agents: linked-only scope, review mode (held mail), hourly caps, release/drop. */
import { join } from "node:path";
import { Hub } from "../src/core/hub.js";
import type { SessionEvent } from "../src/core/session.js";
import { assert, finish, freshDir, mock } from "./util.js";

const dir = freshDir(".hive-test-links");
const work = freshDir(join(dir, "work"));
const log: { agent: string; e: SessionEvent }[] = [];
const hub = new Hub({ hiveDb: join(dir, "hive.db"), pollMs: 200, onEvent: (agent, e) => log.push({ agent, e }) });
const db = hub.db;
const said = (a: string) => log.filter((l) => l.agent === a && l.e.type === "text").map((l) => (l.e as any).text).join("");
const a = await hub.add({ name: "ana", agent: mock("ana"), cwd: work, policy: "allow-all" });
await hub.add({ name: "ben", agent: mock("ben"), cwd: work, policy: "allow-all" });
await hub.add({ name: "cid", agent: mock("cid"), cwd: work, policy: "allow-all" });

// open (default): anyone can message anyone
assert(db.mailScope() === "open", "default scope is open");
await a.prompt("send ben: hello");
assert(db.unreadCount("ben") === 1, "open scope: direct mail delivered");
db.markRead(db.inbox("ben").map((m) => m.id), "ben");

// linked: agents work alone until you link them
db.setMailScope("linked");
await a.prompt("send ben: are you there");
assert(db.unreadCount("ben") === 0 && /aren't linked with ben/.test(said("ana")), "linked scope: unlinked agents can't message each other");
await a.prompt("send *: everyone");
assert(db.unreadCount("cid") === 0 && /only talk to agents they're linked with/.test(said("ana")), "linked scope: no broadcast to everyone");
await a.prompt("grp create sneaky ben");
assert(!db.groupMembers("sneaky").length && /only the human links agents/.test(said("ana")), "linked scope: agents can't link themselves");
await a.prompt("tellowner: I need ben");
assert(db.inbox("owner").some((m) => m.from_agent === "ana"), "agents can always reach the owner");

// link ana + ben (as the UI's drag-and-drop does): direct
db.addToGroup("ana-ben", ["ana", "ben", "owner"]);
await a.prompt("send ben: now linked");
assert(db.unreadCount("ben") === 1 && db.inbox("ben")[0].via === "ana-ben", "linked agents talk directly; message tagged with the group");
db.markRead(db.inbox("ben").map((m) => m.id), "ben");
await a.prompt("send cid: still not linked");
assert(db.unreadCount("cid") === 0, "a link doesn't open mail to others");

// review mode: the layer in between — you approve each message
db.setGroupSettings("ana-ben", { mode: "review" });
await a.prompt("send ben: please run the migration");
assert(db.unreadCount("ben") === 0 && db.heldMessages().length === 1 && /held/.test(said("ana")), "review mode holds agent mail for the owner, and the sender is told");
const held = db.heldMessages()[0];
assert(db.groupMessages("ana-ben").some((m) => m.id === held.id && m.held), "held mail shows in the group chat");
db.releaseMessage(held.id, "please run the migration on staging only");
assert(db.unreadCount("ben") === 1 && db.inbox("ben")[0].body === "please run the migration on staging only", "owner releases (edited) and it's delivered");
db.markRead(db.inbox("ben").map((m) => m.id), "ben");
await a.prompt("send @ana-ben: group note");
assert(db.heldMessages().length === 1, "mail to the group itself is held in review mode too");
db.dropMessage(db.heldMessages()[0].id);
assert(db.heldMessages().length === 0 && db.unreadCount("ben") === 0, "owner drops it; never delivered");
db.send("owner", "@ana-ben", "from you", "owner messages are never held");
assert(db.unreadCount("ben") === 1, "the owner is never held");
db.markRead(db.inbox("ben").map((m) => m.id), "ben");

// hourly cap: 2 more agent messages this hour (2 already went through the group)
db.setGroupSettings("ana-ben", { mode: "direct", max_per_hour: 4 });
for (let i = 0; i < 3; i++) await a.prompt(`send ben: ping ${i}`);
assert(db.unreadCount("ben") === 2 && db.heldMessages().length === 1 && /limit of 4/.test(db.heldMessages()[0].held!), "cap: extra messages are held, not lost");

// follow-ups obey links too
await a.prompt("calltool hive_followup {\"agent\":\"cid\",\"prompt\":\"x\",\"in_minutes\":5}");
assert(/Not scheduled/.test(said("ana")) && !db.listJobs(false).some((j) => j.agent === "cid"), "follow-ups for unlinked agents are refused");

await hub.close();
finish("links");
