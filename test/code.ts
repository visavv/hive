/**
 * Code view backend: file listing (.gitignore respected, walk fallback),
 * reading files confined to the folder (path traversal, absolute paths and
 * symlink escapes refused; binaries and >1 MB files refused), the changes
 * diff, the readFile RPC over the backend protocol, and "explain every
 * change" (turn snapshots, coalescing, rate limit, budget hold).
 */
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { codeDiff, listFiles, looksBinary, parseUnifiedDiff, readCodeFile, MAX_FILE_BYTES } from "../src/core/code.js";
import { ExplainWatcher, explainPrompt, type Delivery } from "../src/core/learn.js";
import { ROLES } from "../src/core/roles.js";
import { nodeEntry } from "../src/core/paths.js";
import { assert, finish, freshDir, sleep, until } from "./util.js";

const base = freshDir(".hive-test-code");
const repo = join(base, "repo");
const outside = join(base, "outside");
mkdirSync(join(repo, "src"), { recursive: true });
mkdirSync(outside, { recursive: true });
const g = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8" });
g(["init", "-q", "-b", "main"]);
g(["config", "user.email", "t@t"]);
g(["config", "user.name", "t"]);
writeFileSync(join(repo, ".gitignore"), "secret.env\nbuild/\n");
writeFileSync(join(repo, "src", "app.ts"), "export function add(a: number, b: number) {\n  return a + b;\n}\n");
writeFileSync(join(repo, "README.md"), "# demo\n");
g(["add", "."]);
g(["commit", "-qm", "init"]);
writeFileSync(join(repo, "secret.env"), "TOKEN=1\n");
mkdirSync(join(repo, "build"));
writeFileSync(join(repo, "build", "out.js"), "x\n");
writeFileSync(join(repo, "src", "new.ts"), "export const n = 1;\n");
writeFileSync(join(repo, "README.md"), "# demo\nmore\n");
writeFileSync(join(outside, "passwd"), "root:x:0:0\n");

// ---- listing ----
const l = await listFiles(repo);
assert(l.source === "git" && l.files.includes("src/app.ts") && l.files.includes("src/new.ts"), "listFiles: tracked and new files");
assert(!l.files.includes("secret.env") && !l.files.some((f) => f.startsWith("build/")), "listFiles: .gitignore'd files are left out");
assert(l.marks["README.md"] === "M" && l.marks["src/new.ts"] === "?" && !l.marks["src/app.ts"], "listFiles: git status marks (modified, new)");
assert(l.branch === "main", "listFiles: current branch");
const sub = await listFiles(join(repo, "src"));
assert(sub.files.includes("app.ts") && sub.marks["new.ts"] === "?", "listFiles in a subfolder: paths and marks relative to it");

const plain = join(base, "plain");
mkdirSync(join(plain, "node_modules", "x"), { recursive: true });
mkdirSync(join(plain, "lib"), { recursive: true });
writeFileSync(join(plain, "node_modules", "x", "i.js"), "");
writeFileSync(join(plain, "lib", "a.py"), "print(1)\n");
const w = await listFiles(plain);
// base is inside this repo's checkout but .hive-test* is ignored there: git lists nothing, so it walks
assert(w.source === "walk" && w.files.includes("lib/a.py") && !w.files.some((f) => f.includes("node_modules")), "not a repo (or ignored): directory walk without node_modules");

// ---- reading, confinement ----
const f = readCodeFile(repo, "src/app.ts");
assert(f.path === "src/app.ts" && f.text.includes("return a + b") && f.lines === 4, "readCodeFile reads a file inside the folder");
assert(readCodeFile(repo, join(repo, "src", "app.ts")).path === "src/app.ts", "an absolute path inside the folder works");
const refuses = (p: string, re: RegExp, what: string) => {
  try {
    readCodeFile(repo, p);
    assert(false, what);
  } catch (e: any) {
    assert(re.test(e.message), `${what} (${e.message})`);
  }
};
refuses("../outside/passwd", /outside the working folder/, "path traversal with .. is refused");
refuses("src/../../outside/passwd", /outside the working folder/, "traversal through a subfolder is refused");
refuses(join(outside, "passwd"), /outside the working folder/, "an absolute path elsewhere is refused");
symlinkSync(join(outside, "passwd"), join(repo, "src", "link.txt"));
symlinkSync(outside, join(repo, "escape"));
refuses("src/link.txt", /outside the working folder/, "a symlink to a file outside is refused");
refuses("escape/passwd", /outside the working folder/, "a symlinked folder pointing outside is refused");
symlinkSync(join(repo, "src", "app.ts"), join(repo, "inside-link.ts"));
assert(readCodeFile(repo, "inside-link.ts").text.includes("add"), "a symlink that stays inside is fine");
writeFileSync(join(repo, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]));
refuses("logo.png", /binary/, "binary files are refused with a clear message");
writeFileSync(join(repo, "big.txt"), "a".repeat(MAX_FILE_BYTES + 10));
refuses("big.txt", /too big.*1 MB/, "files over 1 MB are refused with a clear message");
refuses("src", /folder/, "a folder is not a file");
refuses("nope.ts", /no such file/, "a missing file says so");
assert(!looksBinary(Buffer.from("héllo wörld\n\tok\n")) && looksBinary(Buffer.from([1, 2, 3, 4, 5, 6, 1, 2, 3])), "looksBinary: UTF-8 text vs control bytes");
rmSync(join(repo, "big.txt"));
rmSync(join(repo, "logo.png"));
rmSync(join(repo, "src", "link.txt"));
rmSync(join(repo, "escape"));
rmSync(join(repo, "inside-link.ts"));

// ---- changes ----
const d = await codeDiff(repo);
const readme = d.files.find((x) => x.path === "README.md");
assert(d.base.startsWith("HEAD") && readme?.status === "modified" && readme.adds === 1 && readme.patch.includes("+more"), "codeDiff on the base branch: uncommitted changes");
assert(d.files.some((x) => x.path === "src/new.ts" && x.status === "added" && x.patch.includes("+export const n")), "codeDiff includes new untracked files");
g(["add", "."]);
g(["commit", "-qm", "work"]);
g(["checkout", "-q", "-b", "hive/coder"]);
writeFileSync(join(repo, "src", "app.ts"), "export function add(a: number, b: number) {\n  return b + a;\n}\n");
g(["commit", "-qam", "swap"]);
writeFileSync(join(repo, "src", "wip.ts"), "// wip\n");
rmSync(join(repo, "src", "wip.ts"));
g(["checkout", "-q", "main"]);
const wt = join(base, "wt");
g(["worktree", "add", "-q", wt, "hive/coder"]);
writeFileSync(join(wt, "src", "wip.ts"), "// wip\n");
const d3 = await codeDiff(wt);
assert(d3.base === "main" && d3.files.some((x) => x.path === "src/app.ts" && x.patch.includes("+  return b + a;")) && d3.files.some((x) => x.path === "src/wip.ts"), "codeDiff in an agent worktree: commits since main plus new files");
const parsed = parseUnifiedDiff("diff --git a/x b/y\nsimilarity index 90%\nrename from x\nrename to y\n@@ -1 +1 @@\n-a\n+b\n");
assert(parsed[0].path === "y" && parsed[0].status === "renamed" && parsed[0].adds === 1 && parsed[0].dels === 1, "parseUnifiedDiff: renames and counts");

// ---- readFile over the backend protocol (what the UI calls) ----
const be = nodeEntry("ui/backend");
const proc = spawn(be.command, [...be.args, "--db", join(base, "hive.db"), "--cwd", repo, "--poll", "200"], { stdio: ["pipe", "pipe", "inherit"] });
const waiting = new Map<number, (m: any) => void>();
let ready = false;
createInterface({ input: proc.stdout! }).on("line", (line) => {
  const m = JSON.parse(line);
  if (typeof m.id === "number") waiting.get(m.id)?.(m);
  else if (m.event === "ready") ready = true;
});
let id = 0;
const call = (method: string, params: unknown): Promise<any> =>
  new Promise((res, rej) => {
    const i = ++id;
    waiting.set(i, (m) => (m.error ? rej(new Error(m.error)) : res(m.result)));
    proc.stdin!.write(JSON.stringify({ id: i, method, params }) + "\n");
  });
await until(() => ready, 20_000, "backend ready");
const rf = await call("readFile", { path: "src/app.ts" });
assert(rf.text.includes("export function add"), "readFile RPC reads from the project");
const err = await call("readFile", { path: "../outside/passwd" }).then(() => "", (e) => e.message);
assert(/outside/.test(err), `readFile RPC refuses traversal (${err})`);
const err2 = await call("listFiles", { dir: outside }).then(() => "", (e) => e.message);
assert(/outside the project/.test(err2), `listFiles RPC refuses a folder that's not the project or an agent's (${err2})`);
const lf = await call("listFiles", {});
assert(lf.files.includes("src/app.ts"), "listFiles RPC lists the project");
const ex = await call("explainChanges", {});
assert(Array.isArray(ex.agents) && ex.agents.length === 0 && !ex.teacher, "explainChanges RPC: off by default, no teacher yet");
const ex2 = await call("explainChanges", { agent: "ghost", on: true }).then(() => "", (e) => e.message);
assert(/no agent/.test(ex2), "explainChanges refuses an unknown agent");
proc.stdin!.end();
await new Promise((r) => proc.once("exit", r));

// ---- teacher preset ----
const t = ROLES.teacher;
assert(t && t.policy === "allow-reads" && !t.worktree && /hive_card_add/.test(t.briefing) && /glossary/.test(t.briefing) && /never change/.test(t.briefing), "teacher preset: reads only, glossary cards via hive_card_add");

// ---- explain every change ----
const sent: { prompt: string; from: string }[] = [];
let mode: Delivery = "sent";
const watcher = new ExplainWatcher({
  isOn: (a) => a === "coder",
  cwdOf: () => wt,
  deliver: async (prompt, from) => {
    if (mode === "sent") sent.push({ prompt, from });
    return mode;
  },
  minGapMs: 2500,
});
// a turn that changes nothing
watcher.turnStart("coder");
assert((await watcher.turnEnd("coder")).length === 0 && sent.length === 0, "a turn without file changes sends nothing");
// already-dirty files don't count; a newly changed one does
watcher.turnStart("coder");
await sleep(400);
writeFileSync(join(wt, "src", "app.ts"), "export function add(a: number, b: number) {\n  // add two numbers\n  return b + a;\n}\n");
const ch = await watcher.turnEnd("coder");
assert(ch.length === 1 && ch[0] === "src/app.ts", `only files the turn changed count (${ch.join(",")})`);
assert(sent.length === 1 && sent[0].from === "coder" && sent[0].prompt.includes("coder just changed these files: src/app.ts") && sent[0].prompt.includes("+  // add two numbers"), "the teacher gets the file list and the diff");
// within the rate limit: coalesced into one later prompt
watcher.turnStart("coder");
await sleep(400);
writeFileSync(join(wt, "src", "b.ts"), "export const b = 2;\n");
await watcher.turnEnd("coder");
watcher.turnStart("coder");
await sleep(400);
writeFileSync(join(wt, "src", "c.ts"), "export const c = 3;\n");
await watcher.turnEnd("coder");
assert(sent.length === 1 && watcher.pendingFiles("coder").join(",") === "src/b.ts,src/c.ts", "changes inside the 2-minute window are coalesced");
await until(() => sent.length === 2, 5000, "coalesced prompt");
assert(sent[1].prompt.includes("src/b.ts, src/c.ts") && sent[1].prompt.includes("export const c = 3"), "one prompt for both turns once the window passes");
// other agents aren't watched
watcher.turnStart("reviewer");
assert((await watcher.turnEnd("reviewer")).length === 0, "agents without the toggle are ignored");
// the budget holds it: nothing is sent, it stays pending
mode = "held";
watcher.turnStart("coder");
await sleep(400);
writeFileSync(join(wt, "src", "d.ts"), "export const d = 4;\n");
await watcher.turnEnd("coder");
assert(sent.length === 2 && watcher.pendingFiles("coder").includes("src/d.ts"), "held by the budget guard: kept for later, not sent");
watcher.close();
const big = explainPrompt("coder", ["a"], "x".repeat(100));
assert(big.startsWith("[hive learn] coder just changed") && big.includes("```diff"), "explain prompt format");

finish("code");
