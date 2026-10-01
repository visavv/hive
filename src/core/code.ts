/**
 * Read-only code browsing for the UI's code view: list a folder's files
 * (git's view of it, so .gitignore is respected), read one file, and diff an
 * agent's branch against its base. Nothing here writes to disk.
 *
 * Every path is confined to the folder being browsed (confine.ts): `..`,
 * absolute paths elsewhere and symlinks pointing out of the folder are refused.
 */
import { createHash } from "node:crypto";
import { openSync, readSync, closeSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { confine } from "./confine.js";
import { baseBranch, git, repoRoot } from "./worktree.js";

export const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 20_000;
const SKIP_DIRS = new Set(["node_modules", ".git", ".hive", "dist", "dist-ui", "build", "target", "__pycache__", ".venv", "venv", ".next"]);

/** M modified, A added (staged new), ? untracked, D deleted, R renamed. */
export type FileMark = "M" | "A" | "?" | "D" | "R";

export interface FileList {
  root: string;
  files: string[];
  marks: Record<string, FileMark>;
  branch?: string;
  /** The list was cut at MAX_FILES. */
  truncated: boolean;
  /** "git" (respects .gitignore) or "walk" (not a repo: plain directory walk). */
  source: "git" | "walk";
}

const posix = (p: string) => p.split(sep).join("/");

/** Files under `root`: git's tracked + untracked-not-ignored, else a directory walk. */
export async function listFiles(root: string): Promise<FileList> {
  const real = confine(root, ".");
  let files: string[] | undefined;
  let marks: Record<string, FileMark> = {};
  let branch: string | undefined;
  try {
    const out = await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], real);
    files = [...new Set(out.split("\0").filter(Boolean))];
    // A folder git ignores entirely (or an empty repo dir) lists nothing: walk it instead.
    if (!files.length) files = undefined;
    else {
      marks = await gitMarks(real);
      branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], real).catch(() => "")).trim() || undefined;
      // Deleted files are still in the index: drop the ones gone from disk unless marked.
      files = files.filter((f) => marks[f] !== "D");
    }
  } catch {
    files = undefined;
  }
  const source = files ? "git" : "walk";
  if (!files) files = walk(real);
  files.sort((a, b) => a.localeCompare(b));
  return { root: real, files: files.slice(0, MAX_FILES), marks, branch, truncated: files.length > MAX_FILES, source };
}

async function gitMarks(cwd: string): Promise<Record<string, FileMark>> {
  const prefix = (await git(["rev-parse", "--show-prefix"], cwd).catch(() => "")).trim();
  const out = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd).catch(() => "");
  const marks: Record<string, FileMark> = {};
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    let path = e.slice(3);
    if (xy[0] === "R" || xy[0] === "C") i++; // the next entry is the old name
    if (prefix) {
      if (!path.startsWith(prefix)) continue;
      path = path.slice(prefix.length);
    }
    marks[path] = xy === "??" ? "?" : xy.includes("D") ? "D" : xy[0] === "A" ? "A" : xy[0] === "R" ? "R" : "M";
  }
  return marks;
}

function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (out.length > MAX_FILES || depth > 12) return;
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of ents) {
      if (out.length > MAX_FILES) return;
      if (d.isDirectory()) {
        if (SKIP_DIRS.has(d.name) || d.name.startsWith(".hive")) continue;
        visit(join(dir, d.name), depth + 1);
      } else if (d.isFile()) out.push(posix(relative(root, join(dir, d.name))));
      // symlinks are left out of the walk: they may point anywhere
    }
  };
  visit(root, 0);
  return out;
}

export interface FileContent {
  /** Relative to the root, with forward slashes. */
  path: string;
  abs: string;
  text: string;
  size: number;
  lines: number;
}

/** True if the first 8 KB look binary (a NUL byte, or mostly control characters). */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  if (!n) return false;
  let odd = 0;
  for (let i = 0; i < n; i++) {
    const c = buf[i];
    if (c === 0) return true;
    if (c < 7 || (c > 13 && c < 32 && c !== 27)) odd++;
  }
  return odd / n > 0.1;
}

/** Read one text file inside `root`. Refuses binaries, folders and files over 1 MB. */
export function readCodeFile(root: string, path: string): FileContent {
  const rootReal = confine(root, ".");
  const abs = confine(rootReal, path, path);
  let st;
  try {
    st = statSync(abs);
  } catch {
    throw new Error(`${path}: no such file`);
  }
  if (st.isDirectory()) throw new Error(`${path} is a folder, not a file`);
  if (!st.isFile()) throw new Error(`${path} is not a regular file`);
  if (st.size > MAX_FILE_BYTES) throw new Error(`${path} is too big to show (${(st.size / 1024 / 1024).toFixed(1)} MB; the limit is 1 MB)`);
  const fd = openSync(abs, "r");
  let head: Buffer;
  try {
    head = Buffer.alloc(Math.min(8192, st.size));
    readSync(fd, head, 0, head.length, 0);
  } finally {
    closeSync(fd);
  }
  if (looksBinary(head)) throw new Error(`${path} looks like a binary file (image, archive, compiled code…), so it can't be shown as text`);
  const text = readFileSync(abs, "utf8");
  return { path: posix(relative(rootReal, abs)), abs, text, size: st.size, lines: text ? text.split("\n").length : 0 };
}

export interface DiffFile {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed";
  adds: number;
  dels: number;
  /** Unified diff for this file (hunks only, no header), possibly cut. */
  patch: string;
}

export interface CodeDiff {
  root: string;
  /** What the changes are compared with, e.g. "main" or "HEAD (uncommitted)". */
  base: string;
  branch?: string;
  files: DiffFile[];
  truncated: boolean;
}

const MAX_DIFF_BYTES = 2 * 1024 * 1024;

/**
 * The changes in `root`: on an agent branch (hive/*), everything since it left
 * the base branch, committed or not; elsewhere, uncommitted changes. New
 * untracked files are included as additions.
 */
export async function codeDiff(root: string): Promise<CodeDiff> {
  const real = confine(root, ".");
  let branch: string;
  try {
    branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], real)).trim();
  } catch {
    throw new Error(`${real} is not a git repository, so there is no change history to show`);
  }
  let from = "HEAD";
  let base = "HEAD (uncommitted changes)";
  try {
    const repo = await repoRoot(real);
    const b = await baseBranch(repo);
    if (b && b !== branch && b !== "HEAD") {
      from = (await git(["merge-base", b, "HEAD"], real)).trim();
      base = b;
    }
  } catch {}
  // A repo without commits has no HEAD: everything is new.
  const hasHead = await git(["rev-parse", "--verify", "--quiet", "HEAD"], real).then(
    () => true,
    () => false,
  );
  let raw = hasHead ? await git(["diff", "--no-color", "--no-ext-diff", "-M", "--relative", from], real).catch(() => "") : "";
  let truncated = false;
  if (raw.length > MAX_DIFF_BYTES) {
    raw = raw.slice(0, MAX_DIFF_BYTES);
    truncated = true;
  }
  const files = parseUnifiedDiff(raw);
  const untracked = (await git(["ls-files", "-z", "--others", "--exclude-standard"], real).catch(() => "")).split("\0").filter(Boolean);
  let budget = MAX_DIFF_BYTES - raw.length;
  for (const f of untracked.slice(0, 500)) {
    let text = "";
    try {
      const c = readCodeFile(real, f);
      text = c.text;
    } catch {
      text = "";
    }
    if (budget <= 0) {
      truncated = true;
      text = "";
    }
    const lines = text ? text.replace(/\n$/, "").split("\n") : [];
    const patch = lines.length ? `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => "+" + l).join("\n")}` : "";
    budget -= patch.length;
    files.push({ path: f, status: "added", adds: lines.length, dels: 0, patch });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { root: real, base, branch, files, truncated };
}

/** Split `git diff` output into per-file patches with +/− counts. */
export function parseUnifiedDiff(raw: string): DiffFile[] {
  const out: DiffFile[] = [];
  const chunks = raw.split(/^diff --git /m).filter((c) => c.trim());
  for (const c of chunks) {
    const lines = c.split("\n");
    const head = lines[0];
    let path = head.match(/ b\/(.+)$/)?.[1] ?? head;
    let status: DiffFile["status"] = "modified";
    let i = 1;
    for (; i < lines.length && !lines[i].startsWith("@@"); i++) {
      const l = lines[i];
      if (l.startsWith("new file")) status = "added";
      else if (l.startsWith("deleted file")) status = "deleted";
      else if (l.startsWith("rename to ")) {
        status = "renamed";
        path = l.slice("rename to ".length);
      } else if (l.startsWith("+++ b/")) path = l.slice(6);
      else if (l.startsWith("--- a/") && status === "deleted") path = l.slice(6);
    }
    const body = lines.slice(i);
    let adds = 0;
    let dels = 0;
    for (const l of body) {
      if (l.startsWith("+")) adds++;
      else if (l.startsWith("-")) dels++;
    }
    out.push({ path, status, adds, dels, patch: body.join("\n").replace(/\n$/, "") });
  }
  return out;
}

// ---- "explain every change": what did an agent's turn change? ----

export interface TreeSnapshot {
  head: string | null;
  /** Content hash of every file that differs from HEAD (or is untracked) at snapshot time. */
  dirty: Map<string, string>;
}

function hashFile(abs: string): string {
  try {
    return createHash("sha1").update(readFileSync(abs)).digest("hex");
  } catch {
    return "(gone)";
  }
}

async function dirtyFiles(cwd: string, base: string | null): Promise<string[]> {
  const changed = base ? (await git(["diff", "--name-only", "--relative", "-z", base], cwd).catch(() => "")).split("\0") : [];
  const untracked = (await git(["ls-files", "-z", "--others", "--exclude-standard"], cwd).catch(() => "")).split("\0");
  return [...new Set([...changed, ...untracked].filter(Boolean))];
}

/** Remember the state of a folder before an agent's turn. Undefined outside git. */
export async function snapshotTree(cwd: string): Promise<TreeSnapshot | undefined> {
  try {
    await git(["rev-parse", "--is-inside-work-tree"], cwd);
  } catch {
    return undefined;
  }
  const head = (await git(["rev-parse", "--verify", "--quiet", "HEAD"], cwd).catch(() => "")).trim() || null;
  const dirty = new Map<string, string>();
  for (const f of await dirtyFiles(cwd, head)) dirty.set(f, hashFile(join(cwd, f)));
  return { head, dirty };
}

/** Files whose content changed since `snap` (committed in the meantime or not). */
export async function changedSince(cwd: string, snap: TreeSnapshot): Promise<string[]> {
  const now = await dirtyFiles(cwd, snap.head);
  const out = now.filter((f) => snap.dirty.get(f) !== hashFile(join(cwd, f)));
  // Dirty before, identical to the snapshot's HEAD now: the turn reverted it.
  const still = new Set(now);
  for (const f of snap.dirty.keys()) if (!still.has(f)) out.push(f);
  return [...new Set(out)].sort();
}

/** `git diff` of `files` since `base` (plus new files' contents), cut to `cap` bytes. */
export async function diffOf(cwd: string, base: string | null, files: string[], cap = 8 * 1024): Promise<string> {
  let text = base ? await git(["diff", "--no-color", "--no-ext-diff", "--relative", base, "--", ...files], cwd).catch(() => "") : "";
  const tracked = base ? new Set((await git(["ls-files", "-z", "--", ...files], cwd).catch(() => "")).split("\0").filter(Boolean)) : new Set<string>();
  for (const f of files) {
    if (tracked.has(f) || text.includes(` b/${f}\n`)) continue;
    try {
      const c = readCodeFile(cwd, f);
      text += `\n--- /dev/null\n+++ b/${f} (new file)\n${c.text.split("\n").map((l) => "+" + l).join("\n")}\n`;
    } catch {
      // deleted, binary or too big: the file list still names it
    }
    if (text.length > cap) break;
  }
  if (text.length > cap) text = text.slice(0, cap) + `\n… (diff cut at ${Math.round(cap / 1024)} KB; read the files for the rest)`;
  return text.trim();
}
