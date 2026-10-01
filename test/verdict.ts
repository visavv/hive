/** Verdict mode: one prompt to several agents (own worktrees), blind judge, apply. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hub } from "../src/core/hub.js";
import { applyVerdict, runVerdict, type VerdictState } from "../src/core/verdict.js";
import { assert, finish, freshDir } from "./util.js";

const dir = freshDir(".hive-test-verdict");
const repo = join(dir, "repo");
freshDir(repo);
const g = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8" });
g(["init", "-q", "-b", "main"]);
g(["config", "user.email", "t@t"]);
g(["config", "user.name", "t"]);
writeFileSync(join(repo, "README.md"), "x\n");
g(["add", "."]);
g(["commit", "-qm", "init"]);

const hub = new Hub({ hiveDb: join(dir, "hive.db"), pollMs: 200 });
const progress: string[] = [];
let err = "";
try {
  await runVerdict(hub, { prompt: "x", kinds: ["mock"], judge: "mock", cwd: repo });
} catch (e: any) {
  err = e.message;
}
assert(/at least two/.test(err), "needs two or more contenders");

const s = await runVerdict(hub, {
  prompt: "verdict-task: add a solution file",
  kinds: ["mock", "mock", "mock"],
  judge: "mock",
  cwd: repo,
  onProgress: (v) => progress.push(v.status + ":" + v.contenders.map((c) => c.status[0]).join("")),
});
assert(s.status === "done", `round finished (${s.status} ${s.error ?? ""})`);
assert(s.contenders.every((c) => c.status === "done" && c.branch?.startsWith(`hive/v${s.id}-`)) && new Set(s.contenders.map((c) => c.path)).size === 3, "each contender worked in its own worktree and branch");
assert(s.contenders.every((c) => readFileSync(join(c.path!, "solution.txt"), "utf8").startsWith("solution by")), "contenders' work is in their worktrees");
assert(!existsSync(join(repo, "solution.txt")), "your checkout is untouched");
assert(s.contenders.every((c) => /solution\.txt/.test(c.diffStat ?? "")), "uncommitted new files are part of each solution's diff");
assert(s.base === "A" && /3 solutions compared/.test(s.verdict!) && /untrusted-wrapped: true/.test(s.verdict!) && /saw diff: true/.test(s.verdict!), "judge saw all solutions blind (A/B/C, wrapped untrusted, with diffs) and chose a base");
assert(progress.some((p) => p.startsWith("running:www")) && progress.some((p) => p.startsWith("judging")) && progress.at(-1)!.startsWith("done"), `progress reported (${progress.join(" → ")})`);
assert(existsSync(s.report!) && /Solution A\*\* = mock/.test(readFileSync(s.report!, "utf8")), "report saved with the contenders revealed");
assert(hub.db.inbox("owner").some((m) => m.subject === `verdict #${s.id} ready`), "owner is told when the verdict is ready");
assert(hub.sessions.size === 0, "contender and judge processes are closed after the round");

const a = await applyVerdict(hub, s.id);
const base = a.contenders.find((c) => c.label === "A")!;
assert(a.status === "applied" && readFileSync(join(base.path!, "solution.txt"), "utf8") === "merged solution\n", "apply: the base solution's author builds the merged version in its worktree");
assert(hub.db.getVerdict<VerdictState>(s.id)?.status === "applied", "verdict state persisted");

// text mode: no git needed
const t = await runVerdict(hub, { prompt: "titles for my video", kinds: ["mock", "mock"], judge: "mock", cwd: dir, mode: "text" });
assert(t.status === "done" && t.contenders.every((c) => !c.branch), "text mode compares answers without worktrees");
let codeErr = "";
try {
  await runVerdict(hub, { prompt: "x", kinds: ["mock", "mock"], judge: "mock", cwd: join(dir, "nogit") });
} catch (e: any) {
  codeErr = e.message;
}
assert(/git repository/.test(codeErr), "code mode outside a git repo explains itself");

await hub.close();
finish("verdict");
