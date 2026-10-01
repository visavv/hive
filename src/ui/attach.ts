/**
 * `hive daemon` and `hive attach`: run a project's hive in the background and connect
 * to it from anywhere you can SSH to (desktop app with --remote, a terminal, a phone).
 */
import { spawn } from "node:child_process";
import { openSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { nodeEntry } from "../core/paths.js";
import { projectDir } from "../core/home.js";
import { attachStdio, control, isLive, runMux, socketPath } from "./mux.js";

/** Foreground: keep the project's backend running (systemd runs this). */
export async function runDaemon(cwd: string, log = (s: string) => process.stderr.write(s.endsWith("\n") ? s : s + "\n")): Promise<void> {
  const be = nodeEntry("ui/backend");
  const m = await runMux({
    cwd,
    backend: { command: be.command, args: [...be.args, "--cwd", cwd, "--owner-pid", String(process.pid)] },
    log,
    onExit: (code) => process.exit(code),
  });
  log(`hive daemon: ${cwd} (socket ${m.path})`);
  const stop = () => void m.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

/** Start the daemon in the background if it isn't running; resolves when its socket answers. */
export async function ensureDaemon(cwd: string): Promise<string> {
  const path = socketPath(cwd);
  if (await isLive(path)) return path;
  const cli = nodeEntry("cli/index");
  mkdirSync(projectDir(cwd), { recursive: true });
  const logFd = openSync(join(projectDir(cwd), "daemon.log"), "a");
  const child = spawn(cli.command, [...cli.args, "daemon", "--cwd", cwd], { cwd, detached: true, stdio: ["ignore", logFd, logFd], windowsHide: true });
  child.unref();
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (await isLive(path)) return path;
  }
  throw new Error(`hive daemon didn't start; see ${join(projectDir(cwd), "daemon.log")}`);
}

/** stdin/stdout ⇄ the project's daemon (starting it if needed). What the desktop app runs over SSH. */
export async function attach(cwd: string): Promise<void> {
  const path = await ensureDaemon(cwd);
  await attachStdio(path);
}

export async function daemonStatus(cwd: string): Promise<string> {
  const path = socketPath(cwd);
  if (!(await isLive(path))) return "not running";
  const s = await control(path, "status");
  if (s.mux !== "status") return "not running";
  return `running (pid ${s.pid}, ${s.clients} client${s.clients === 1 ? "" : "s"} attached)`;
}

export async function stopDaemon(cwd: string): Promise<boolean> {
  const path = socketPath(cwd);
  if (!(await isLive(path))) return false;
  await control(path, "stop");
  return true;
}
