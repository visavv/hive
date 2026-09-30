/**
 * Changed-line counting for `watch` jobs.
 *
 * A shadow git dir per job (under .hive/watch/) snapshots the watched tree
 * with its own index, so we can `git diff --numstat` two snapshots:
 *  - untracked files count (a plain `git diff` against HEAD would miss them)
 *  - the user's own index/stash/refs are never touched
 *  - works on directories that aren't git repos at all
 *  - .gitignore files in the tree are still honoured
 * chokidar only tells us *when* to recount; git decides *how much* changed.
 */
import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";

/** Paths watchers and snapshots always skip. */
export const IGNORED = /(^|[\/\\])(\.git|node_modules|\.hive)([\/\\]|$)/;

export interface DiffStat {
  lines: number;
  files: { path: string; added: number; deleted: number }[];
}

export class ChangeCounter {
  private root!: string;
  private pathspec: string[] = [];
  private ready?: Promise<void>;

  constructor(
    private watchPath: string,
    private gitDir: string,
  ) {}

  private async init() {
    const p = resolve(this.watchPath);
    const st = await stat(p);
    this.root = st.isDirectory() ? p : dirname(p);
    this.pathspec = st.isDirectory() ? [] : ["--", basename(p)];
    if (!existsSync(join(this.gitDir, "HEAD"))) {
      await mkdir(this.gitDir, { recursive: true });
      await git(["init", "--bare", "--quiet", this.gitDir], process.cwd());
    }
    await mkdir(join(this.gitDir, "info"), { recursive: true });
    await writeFile(join(this.gitDir, "info", "exclude"), ".git\nnode_modules/\n.hive/\n");
  }

  private git(args: string[]) {
    return git(
      ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", "core.quotepath=false", ...args],
      this.root,
      { GIT_DIR: this.gitDir, GIT_WORK_TREE: this.root, GIT_INDEX_FILE: join(this.gitDir, "index") },
    );
  }

  /** Snapshot the watched tree; returns a git tree hash. */
  async snapshot(): Promise<string> {
    this.ready ??= this.init();
    await this.ready;
    await this.git(["add", "-A", "--ignore-errors", ...(this.pathspec.length ? this.pathspec : ["--", "."])]);
    return (await this.git(["write-tree"])).trim();
  }

  /** Lines added + deleted between two snapshots (binary files count 0). */
  async diff(from: string, to: string): Promise<DiffStat> {
    this.ready ??= this.init();
    await this.ready;
    if (from === to) return { lines: 0, files: [] };
    const out = await this.git(["diff", "--numstat", "--no-renames", from, to]);
    const files: DiffStat["files"] = [];
    let lines = 0;
    for (const row of out.split("\n")) {
      const m = row.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!m) continue;
      const added = m[1] === "-" ? 0 : Number(m[1]);
      const deleted = m[2] === "-" ? 0 : Number(m[2]);
      lines += added + deleted;
      files.push({ path: m[3], added, deleted });
    }
    return { lines, files };
  }

  /** True if `ref` is a tree this shadow repo still has. */
  async has(ref: string): Promise<boolean> {
    this.ready ??= this.init();
    await this.ready;
    try {
      await this.git(["cat-file", "-e", `${ref}^{tree}`]);
      return true;
    } catch {
      return false;
    }
  }
}

function git(args: string[], cwd: string, env: Record<string, string> = {}): Promise<string> {
  return new Promise((res, rej) => {
    execFile(
      "git",
      args,
      { cwd, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => (err ? rej(new Error(`git ${args.join(" ")}: ${stderr || err.message}`)) : res(stdout)),
    );
  });
}

/** chokidar watcher that calls `onChange` (debounced) when anything under `path` changes. */
export function watchTree(path: string, onChange: () => void, debounceMs = 500): FSWatcher {
  let t: NodeJS.Timeout | undefined;
  const w = chokidar.watch(resolve(path), {
    ignored: (p) => IGNORED.test(p),
    ignoreInitial: true,
    awaitWriteFinish: false,
  });
  w.on("all", () => {
    clearTimeout(t);
    t = setTimeout(onChange, debounceMs);
  });
  return w;
}

/** Short human summary of a diff for the job prompt. */
export function describeDiff(d: DiffStat, max = 30): string {
  const top = [...d.files].sort((a, b) => b.added + b.deleted - (a.added + a.deleted)).slice(0, max);
  const rows = top.map((f) => `  +${f.added} -${f.deleted}  ${f.path}`);
  if (d.files.length > max) rows.push(`  … and ${d.files.length - max} more files`);
  return `${d.lines} changed lines in ${d.files.length} file${d.files.length === 1 ? "" : "s"}:\n${rows.join("\n")}`;
}
