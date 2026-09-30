/**
 * One git worktree per coding agent (design rule 4). Worktrees live in
 * <repo>/.hive/worktrees/<agent> on branch hive/<agent>; .hive/ ignores
 * itself so the main checkout never sees them as untracked files.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

export interface WorktreeInfo {
  name: string;
  path: string;
  branch: string;
  /** Commits on the agent branch not on the base branch, and vice versa. */
  ahead: number;
  behind: number;
  files: number;
  insertions: number;
  deletions: number;
  /** Uncommitted changes in the worktree. */
  dirty: number;
}

export function git(args: string[], cwd: string): Promise<string> {
  return new Promise((res, rej) =>
    execFile("git", args, { cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
      err ? rej(new Error((stderr || err.message).trim())) : res(stdout),
    ),
  );
}

/**
 * The main checkout of the repo containing `cwd` — also when `cwd` is inside
 * one of its worktrees (where --show-toplevel would return the worktree).
 */
export async function repoRoot(cwd: string): Promise<string> {
  let common: string;
  try {
    common = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd)).trim();
  } catch {
    throw new Error(`${cwd} is not inside a git repository (needed for --worktree)`);
  }
  // <repo>/.git → <repo>; a bare repo has no main checkout to merge into.
  if (basename(common) === ".git") return dirname(resolve(common));
  return resolve((await git(["rev-parse", "--show-toplevel"], cwd)).trim());
}

/** Make <dir>/.hive ignore itself in any repo it lands in. */
export function selfIgnoreHiveDir(hiveDir: string) {
  mkdirSync(hiveDir, { recursive: true });
  const gi = join(hiveDir, ".gitignore");
  if (!existsSync(gi)) writeFileSync(gi, "# created by hive\n*\n");
}

export const branchFor = (name: string) => `hive/${name}`;

/** Create (or reuse) the worktree for agent `name` off the repo containing `cwd`. */
export async function ensureWorktree(cwd: string, name: string): Promise<{ path: string; branch: string; repo: string; created: boolean }> {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`bad worktree name "${name}"`);
  const repo = await repoRoot(cwd);
  selfIgnoreHiveDir(join(repo, ".hive"));
  const path = join(repo, ".hive", "worktrees", name);
  const branch = branchFor(name);
  if (existsSync(join(path, ".git"))) return { path, branch, repo, created: false };
  // Needs at least one commit to branch from.
  try {
    await git(["rev-parse", "--verify", "HEAD"], repo);
  } catch {
    throw new Error(`${repo} has no commits yet; commit once before giving agents worktrees`);
  }
  await git(["worktree", "prune"], repo).catch(() => {});
  const exists = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo).then(
    () => true,
    () => false,
  );
  await git(exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, "HEAD"], repo);
  return { path, branch, repo, created: true };
}

/** The branch checked out in the main worktree (merge target). */
export async function baseBranch(repo: string): Promise<string> {
  return (await git(["rev-parse", "--abbrev-ref", "HEAD"], repo)).trim();
}

/** Status of every hive worktree in the repo containing `cwd`. */
export async function listWorktrees(cwd: string): Promise<{ repo: string; base: string; worktrees: WorktreeInfo[] }> {
  const repo = await repoRoot(cwd);
  const base = await baseBranch(repo);
  const prefix = join(repo, ".hive", "worktrees") + sep;
  const porcelain = await git(["worktree", "list", "--porcelain"], repo);
  const out: WorktreeInfo[] = [];
  for (const block of porcelain.split(/\n\n+/)) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    const ref = block.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    if (!path || !ref || !resolve(path).startsWith(prefix)) continue;
    const name = resolve(path).slice(prefix.length);
    const [behind, ahead] = (await git(["rev-list", "--left-right", "--count", `${base}...${ref}`], repo).catch(() => "0 0"))
      .trim()
      .split(/\s+/)
      .map(Number);
    const short = await git(["diff", "--shortstat", `${base}...${ref}`], repo).catch(() => "");
    const dirty = (await git(["status", "--porcelain"], path).catch(() => "")).split("\n").filter(Boolean).length;
    out.push({
      name,
      path: resolve(path),
      branch: ref,
      ahead: ahead || 0,
      behind: behind || 0,
      files: Number(short.match(/(\d+) files? changed/)?.[1] ?? 0),
      insertions: Number(short.match(/(\d+) insertions?/)?.[1] ?? 0),
      deletions: Number(short.match(/(\d+) deletions?/)?.[1] ?? 0),
      dirty,
    });
  }
  return { repo, base, worktrees: out };
}

/**
 * Merge hive/<name> into the main checkout's branch with --no-ff. Refuses if
 * the main checkout has uncommitted tracked changes; aborts cleanly on conflict.
 */
export async function mergeWorktree(cwd: string, name: string): Promise<{ ok: boolean; message: string }> {
  const repo = await repoRoot(cwd);
  const branch = branchFor(name);
  const dirty = (await git(["status", "--porcelain", "--untracked-files=no"], repo)).trim();
  if (dirty) return { ok: false, message: `main checkout has uncommitted changes; commit or stash them first:\n${dirty}` };
  const base = await baseBranch(repo);
  try {
    const out = await git(["merge", "--no-ff", "--no-edit", "-m", `Merge ${branch} (hive agent ${name})`, branch], repo);
    return { ok: true, message: `merged ${branch} into ${base}\n${out.trim()}` };
  } catch (e: any) {
    await git(["merge", "--abort"], repo).catch(() => {});
    return { ok: false, message: `merge of ${branch} into ${base} conflicted and was aborted — ask the agent to rebase on ${base}:\n${e.message}` };
  }
}

/** Remove the worktree (and its branch when `deleteBranch`). */
export async function removeWorktree(cwd: string, name: string, opts: { force?: boolean; deleteBranch?: boolean } = {}) {
  const repo = await repoRoot(cwd);
  const path = join(repo, ".hive", "worktrees", name);
  await git(["worktree", "remove", ...(opts.force ? ["--force"] : []), path], repo);
  if (opts.deleteBranch) await git(["branch", opts.force ? "-D" : "-d", branchFor(name)], repo);
}
