/** Worktree per coding agent: create, status, merge, conflict abort, hub integration, self-ignoring .hive. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWorktree, listWorktrees, mergeWorktree, removeWorktree } from "../src/core/worktree.js";
import { Hub } from "../src/core/hub.js";
import { ROLES } from "../src/core/roles.js";
import { assert, finish, freshDir, mock } from "./util.js";

const repo = freshDir(".hive-test-worktree/repo");
const g = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
g(["init", "-q", "-b", "main"]);
g(["config", "user.email", "t@t"]);
g(["config", "user.name", "t"]);
writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
g(["add", "."]);
g(["commit", "-qm", "init"]);

const wt = await ensureWorktree(repo, "zucchini");
assert(wt.created && existsSync(join(wt.path, "a.txt")) && wt.branch === "hive/zucchini", "worktree created on hive/<name>");
assert(!wt.path.startsWith(repo), "default worktree location is outside the repo (per-user project dir)");
assert(g(["status", "--porcelain"]) === "", ".hive/ ignores itself: main checkout stays clean");
const again = await ensureWorktree(repo, "zucchini");
assert(!again.created && again.path === wt.path, "ensureWorktree reuses an existing worktree");

writeFileSync(join(wt.path, "b.txt"), "new\nfile\n");
g(["add", "."], wt.path);
g(["commit", "-qm", "agent work"], wt.path);
writeFileSync(join(wt.path, "scratch.txt"), "uncommitted\n");
let st = (await listWorktrees(repo)).worktrees.find((w) => w.name === "zucchini")!;
assert(st.ahead === 1 && st.behind === 0 && st.files === 1 && st.insertions === 2 && st.dirty === 1, `status: ahead/diffstat/dirty (${JSON.stringify(st)})`);

const fromInside = await listWorktrees(wt.path);
assert(fromInside.repo === repo && fromInside.worktrees.some((w) => w.name === "zucchini"), "listing from inside a worktree finds the main repo");
const m = await mergeWorktree(wt.path, "zucchini");
assert(m.ok && existsSync(join(repo, "b.txt")), "merge brings the agent's commit into main");

// conflict: both sides edit the same line
writeFileSync(join(wt.path, "a.txt"), "ONE (agent)\ntwo\n");
g(["commit", "-qam", "agent edit"], wt.path);
writeFileSync(join(repo, "a.txt"), "ONE (human)\ntwo\n");
g(["commit", "-qam", "human edit"]);
const c = await mergeWorktree(repo, "zucchini");
assert(!c.ok && /conflicted and was aborted/.test(c.message), "conflicting merge is refused and aborted");
assert(readFileSync(join(repo, "a.txt"), "utf8").startsWith("ONE (human)") && g(["status", "--porcelain"]) === "", "main checkout left clean after aborted merge");

writeFileSync(join(repo, "a.txt"), "dirty\n");
const d = await mergeWorktree(repo, "zucchini");
assert(!d.ok && /uncommitted changes/.test(d.message), "merge refused when main checkout is dirty");
g(["checkout", "a.txt"]);

// hub: worktree option puts the agent in its worktree, and resume still matches
const hub = new Hub({ hiveDb: join(repo, ".hive", "hive.db") });
const s = await hub.add({ name: "bongo", agent: mock("bongo"), cwd: repo, worktree: true, policy: "allow-all", briefing: ROLES.coder.briefing });
assert(s.cwd === join(repo, ".hive", "worktrees", "bongo") && g(["rev-parse", "--abbrev-ref", "HEAD"], s.cwd) === "hive/bongo", "hub.add({worktree}) runs the agent in its worktree next to the hive db");
const sid = s.sessionId;
await hub.remove("bongo", false);
const s2 = await hub.add({ name: "bongo", agent: mock("bongo"), cwd: repo, worktree: true, policy: "allow-all", resume: true });
assert(s2.sessionId === sid, "resume works for worktree agents");
await hub.close();

await removeWorktree(repo, "bongo", { force: true, deleteBranch: true });
st = (await listWorktrees(repo)).worktrees.find((w) => w.name === "bongo")!;
assert(!st, "worktree removed");

const bare = mkdtempSync(join(tmpdir(), "hive-nogit-"));
let err = "";
await ensureWorktree(bare, "x").catch((e) => (err = e.message));
assert(/not inside a git repository/.test(err), "clear error outside a git repo");

finish("worktree");
