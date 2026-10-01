/**
 * Where hive keeps its state: outside the workspace, per user.
 *
 *   <home>/projects/<repo>-<hash>/hive.db       one hive per repo (shared by CLI, serve, UI)
 *   <home>/projects/<repo>-<hash>/ui.json       pane layout
 *   <home>/projects/<repo>-<hash>/watch/        shadow git dirs for watch jobs
 *   <home>/projects/<repo>-<hash>/worktrees/    one git worktree per coding agent
 *
 * Keeping the db out of the repo means agents that can write their workspace
 * can't insert jobs or forge mail, running `hive jobs` from any subfolder (or
 * with --cwd) finds the same hive, and worktrees don't nest inside the repo
 * (Windows path limits, tools scanning duplicate copies).
 *
 * <home> = $HIVE_HOME, else %LOCALAPPDATA%\hive (Windows),
 * ~/Library/Application Support/hive (macOS), $XDG_STATE_HOME/hive or ~/.local/state/hive.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export function hiveHome(): string {
  if (process.env.HIVE_HOME) return resolve(process.env.HIVE_HOME);
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "hive");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "hive");
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "hive");
}

/** Main checkout of the git repo containing `cwd`, or `cwd` itself. */
export function projectRoot(cwd: string): string {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    if (basename(common) === ".git") return dirname(resolve(common));
  } catch {}
  return resolve(cwd);
}

export function projectDir(cwd: string): string {
  const root = projectRoot(cwd);
  const slug = basename(root).replace(/[^\w.-]+/g, "_").slice(0, 40) || "root";
  const hash = createHash("sha1").update(process.platform === "win32" ? root.toLowerCase() : root).digest("hex").slice(0, 8);
  return join(hiveHome(), "projects", `${slug}-${hash}`);
}

export function defaultDb(cwd: string): string {
  return join(projectDir(cwd), "hive.db");
}

// ---- the project bare `hive` (and the desktop launcher) opens ----

const lastFile = () => join(hiveHome(), "last-project");

/** The folder hive was last opened on, if it still exists. */
export function lastProject(): string | undefined {
  try {
    const p = readFileSync(lastFile(), "utf8").trim();
    return p && existsSync(p) ? p : undefined;
  } catch {
    return undefined;
  }
}

export function rememberProject(dir: string) {
  try {
    mkdirSync(hiveHome(), { recursive: true });
    writeFileSync(lastFile(), resolve(dir) + "\n");
  } catch {}
}

/**
 * Which folder to open when you just type `hive` (or click the launcher): the folder you're
 * in when it looks like a project, else the last one you opened, else ask (undefined).
 * Your home folder, a drive root, system folders and hive's own checkout don't count.
 */
export function pickProject(cwd: string, o: { home?: string; hiveRoot?: string; last?: string } = {}): string | undefined {
  const norm = (p: string) => resolve(p).replace(/[\\/]+$/, "").toLowerCase();
  const here = norm(cwd);
  const home = norm(o.home ?? homedir());
  const notProject =
    here === home ||
    resolve(cwd) === resolve(cwd, "..") || // drive / filesystem root
    /^[a-z]:\\windows(\\|$)/.test(here) ||
    /[\\/](system32|syswow64)$/.test(here) ||
    (o.hiveRoot !== undefined && here === norm(o.hiveRoot));
  if (!notProject) return resolve(cwd);
  return o.last;
}
