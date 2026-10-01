/** Kanban board: add, order, drag (move before), done hides, labels, filters. */
import { join } from "node:path";
import { assert, finish, freshDir } from "./util.js";
import { Board } from "../src/hive/kanban.js";

const dir = freshDir(".hive-test-kanban");
const b = new Board(join(dir, "board.db"));
const a = b.add({ title: "Review Twitch clips from Friday", project: "twitch", labels: ["Clips", "clips", "stream ops"] });
const c = b.add({ title: "Rate limiting", project: "acme-api", source: "planner" });
const d = b.add({ title: "Thumbnail ideas" });
assert(b.list().map((x) => x.id).join() === [d.id, c.id, a.id].join(), "new cards go on top of Draft");
assert(a.labels.join() === "clips,stream-ops", "labels are normalised and de-duplicated");

b.move(c.id, "doing");
b.move(a.id, "doing");
assert(b.list().filter((x) => x.col === "doing").map((x) => x.id).join() === [a.id, c.id].join(), "moving puts the card on top of the column");
b.move(c.id, "doing", a.id);
assert(b.list().filter((x) => x.col === "doing").map((x) => x.id).join() === [c.id, a.id].join(), "drag before another card reorders");
b.move(d.id, "doing", null);
assert(b.list().filter((x) => x.col === "doing").at(-1)!.id === d.id, "drop at the end of a column");

b.move(a.id, "done");
assert(!b.list().some((x) => x.id === a.id) && b.list({ done: true }).some((x) => x.id === a.id && x.doneAt), "Done cards disappear from the board but are kept");
assert(b.counts().done === 1 && b.counts().doing === 2, "counts include the hidden Done column");
b.move(a.id, "draft");
assert(b.get(a.id)!.doneAt === null && b.list().some((x) => x.id === a.id), "a Done card can be brought back");

assert(b.list({ project: "acme-api" }).length === 1 && b.list({ label: "clips" }).length === 1 && b.list({ q: "thumb" }).length === 1, "filter by project, label and text");
b.update(c.id, { body: "429 + Retry-After", labels: ["api"] });
assert(b.get(c.id)!.body === "429 + Retry-After" && b.get(c.id)!.labels.join() === "api", "edit body and labels");
let threw = false;
try {
  b.add({ title: "  " });
} catch {
  threw = true;
}
assert(threw, "a card needs a title");
assert(b.remove(d.id) && !b.get(d.id), "delete a card");
b.close();
finish("kanban");
