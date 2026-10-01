/** Worktree per coding agent: create, status, merge, conflict abort, hub integration, self-ignoring .hive. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWorktree, initRepo, listWorktrees, mergeWorktree, removeWorktree } from "../src/core/worktree.js";
import { Hub } from "../src/core/hub.js";
import { ROLES } from "../src/core/roles.js";
import { Scheduler } from "../src/core/scheduler.js";
import { BRANCHES } from "../src/core/watch.js";
import { assert, finish, freshDir, mock, until } from "./util.js";

process.env.HIVE_HOME = freshDir(".hive-test-worktree/home");
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
writeFileSync(join(s.cwd, "review-me.ts"), "export const x = 1;\n");
g(["add", "."], s.cwd);
g(["commit", "-qm", "bongo work"], s.cwd);
const reviewer = await hub.add({ name: "rev", agent: mock("rev"), cwd: repo, policy: "allow-reads" });
let revText = "";
reviewer.on("event", (e) => e.type === "text" && (revText += e.text));
await reviewer.prompt("hivediff bongo");
assert(/# hive\/bongo vs main/.test(revText) && /review-me\.ts/.test(revText) && /bongo work/.test(revText), "hive_diff shows another agent's branch, commits and files (no shell needed)");
revText = "";
await reviewer.prompt("hivediff bongo branch=--output=/tmp/hive-pwned");
assert(/invalid branch/.test(revText) && !existsSync("/tmp/hive-pwned"), "hive_diff rejects option-like refs (no git option injection)");
const sid = s.sessionId;
await hub.remove("bongo", false);
const s2 = await hub.add({ name: "bongo", agent: mock("bongo"), cwd: repo, worktree: true, policy: "allow-all", resume: true });
assert(s2.sessionId === sid, "resume works for worktree agents");
// ---- security watcher following agent branches ----
const sched = new Scheduler({ hub, tickMs: 100, branchPollMs: 150, retryMs: 200 });
const jid = hub.db.addJob({ agent: "sec", agent_kind: "mock", cwd: repo, prompt: "security review", kind: "watch", watch_path: BRANCHES, watch_min_lines: 5 });
sched.start();
await until(() => !!hub.db.getJob(jid)?.watch_ref, 5000, "branch baseline");
const bw = (await ensureWorktree(repo, "coder2")).path;
writeFileSync(join(bw, "small.ts"), "a\nb\n");
g(["add", "."], bw);
g(["commit", "-qm", "small"], bw);
await new Promise((r) => setTimeout(r, 800));
assert(hub.db.jobRuns(jid).length === 0, "branch watch: 2 committed lines don't fire (min 5)");
writeFileSync(join(bw, "big.ts"), "1\n2\n3\n4\n5\n");
g(["add", "."], bw);
g(["commit", "-qm", "big"], bw);
await until(() => hub.db.jobRuns(jid).some((r) => r.ended), 10_000, "branch watch run");
const bp = hub.db.events(0, 100_000).filter((e) => e.agent === "sec" && e.type === "prompt").map((e) => JSON.parse(e.data).text).pop() ?? "";
assert(/hive\/coder2/.test(bp) && /7 changed lines/.test(bp) && /hive_diff/.test(bp), "branch watch fires on commits to hive/* and tells the reviewer what to inspect");
await sched.stop();
await hub.close();

await removeWorktree(repo, "bongo", { force: true, deleteBranch: true });
st = (await listWorktrees(repo)).worktrees.find((w) => w.name === "bongo")!;
assert(!st, "worktree removed");

const bare = mkdtempSync(join(tmpdir(), "hive-nogit-"));
let err = "";
await ensureWorktree(bare, "x").catch((e) => (err = e.message));
assert(/not inside a git repository/.test(err), "clear error outside a git repo");

// a worktree agent in a folder that isn't a git project starts anyway, in the folder, and says why
{
  const plain = mkdtempSync(join(tmpdir(), "hive-plain-"));
  const h = new Hub({ hiveDb: join(mkdtempSync(join(tmpdir(), "hive-plaindb-")), "hive.db"), pollMs: 200 });
  const notes: string[] = [];
  const opts = (h as any).opts;
  const prev = opts.onEvent;
  opts.onEvent = (n: string, e: any) => {
    if (e.type === "notice") notes.push(e.text);
    prev?.(n, e);
  };
  const s = await h.add({ name: "loose", agent: mock("loose"), cwd: plain, policy: "ask", worktree: true });
  assert(s.cwd === plain && notes.some((t) => /works directly in/.test(t) && /git init/.test(t)), `no git project: the agent starts in the folder with a notice (${notes.join(" | ").slice(0, 120)})`);
  await h.close();
  assert((await initRepo(plain)) === "created" && (await initRepo(plain)) === "already", "initRepo makes a git project with a first commit, once");
  const wt2 = await ensureWorktree(plain, "after");
  assert(existsSync(wt2.path), "after initRepo, worktrees work there");
}

finish("worktree");
