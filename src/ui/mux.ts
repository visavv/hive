/**
 * Keeps one hive UI backend running for a project and lets any number of clients
 * attach and detach (desktop app on another machine over SSH, a second window,
 * a phone). Agents keep working while nobody is attached.
 *
 * The socket is local only: a unix socket in the project's state dir (owner-only)
 * or a named pipe on Windows. Remote devices reach it through SSH (`hive attach`),
 * so nothing listens on the network.
 *
 *   client ⇄ (NDJSON over socket) ⇄ mux ⇄ (NDJSON over stdio) ⇄ backend
 *
 * Request ids are rewritten per client so replies go back to the right one;
 * events go to everyone. The last "ready" event is replayed to new clients.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { projectDir, projectRoot } from "../core/home.js";

export function socketPath(cwd: string): string {
  if (process.platform === "win32") {
    const h = createHash("sha1").update(projectRoot(cwd).toLowerCase()).digest("hex").slice(0, 12);
    return `\\\\.\\pipe\\hive-${process.env.USERNAME ?? "user"}-${h}`;
  }
  return join(projectDir(cwd), "hive.sock");
}

interface Client {
  sock: Socket;
  id: number;
}

export interface MuxOptions {
  cwd: string;
  /** Command that starts the backend (stdio NDJSON). */
  backend: { command: string; args: string[]; env?: NodeJS.ProcessEnv };
  /** Exit when the backend exits and can't be restarted. */
  onExit?: (code: number) => void;
  log?: (s: string) => void;
}

/** Run the multiplexer in this process. Resolves once it's listening. */
export async function runMux(o: MuxOptions): Promise<{ close: () => Promise<void>; path: string }> {
  const path = socketPath(o.cwd);
  const log = o.log ?? (() => {});
  if (process.platform !== "win32") {
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    if (existsSync(path)) {
      if (await isLive(path)) throw new Error(`hive is already running for this project (${path})`);
      rmSync(path, { force: true }); // stale socket from a crash
    }
  }
  const clients = new Set<Client>();
  let nextClient = 1;
  let nextId = 1;
  const pending = new Map<number, { client: Client; id: number }>();
  let readyLine: string | undefined;
  let backend: ChildProcess | undefined;
  let closing = false;
  let crashes: number[] = [];

  const broadcast = (line: string) => {
    for (const c of clients) if (!c.sock.destroyed) c.sock.write(line + "\n");
  };

  const start = () => {
    readyLine = undefined;
    const proc = spawn(o.backend.command, o.backend.args, { cwd: o.cwd, env: o.backend.env ?? process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    backend = proc;
    proc.stderr?.on("data", (d) => log(`[backend] ${d}`));
    createInterface({ input: proc.stdout! }).on("line", (line) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof msg.id === "number") {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (!p.client.sock.destroyed) p.client.sock.write(JSON.stringify({ ...msg, id: p.id }) + "\n");
        return;
      }
      if (msg.event === "ready") readyLine = line;
      broadcast(line);
    });
    proc.on("exit", (code) => {
      if (backend === proc) backend = undefined;
      for (const [id, p] of pending) {
        pending.delete(id);
        if (!p.client.sock.destroyed) p.client.sock.write(JSON.stringify({ id: p.id, error: "hive backend restarted" }) + "\n");
      }
      if (closing) return;
      broadcast(JSON.stringify({ event: "backend_down", text: `backend exited (${code}); restarting…` }));
      const now = Date.now();
      crashes = [...crashes.filter((t) => now - t < 60_000), now];
      if (crashes.length >= 5) {
        log("backend keeps crashing (5 times in a minute); giving up");
        void close().then(() => o.onExit?.(1));
        return;
      }
      setTimeout(start, 500);
    });
  };

  const server = createServer((sock) => {
    const client: Client = { sock, id: nextClient++ };
    clients.add(client);
    log(`client ${client.id} attached (${clients.size} now)`);
    if (readyLine) sock.write(readyLine + "\n");
    createInterface({ input: sock }).on("line", (line) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      // control lines from `hive attach --status / --stop`
      if (msg.mux === "status") return void sock.write(JSON.stringify({ mux: "status", clients: clients.size - 1, backend: !!backend, pid: process.pid }) + "\n");
      if (msg.mux === "stop") {
        sock.write(JSON.stringify({ mux: "stopping" }) + "\n");
        return void close().then(() => o.onExit?.(0));
      }
      if (typeof msg.id !== "number" || !backend?.stdin?.writable) {
        if (typeof msg.id === "number") sock.write(JSON.stringify({ id: msg.id, error: "hive backend is restarting" }) + "\n");
        return;
      }
      const id = nextId++;
      pending.set(id, { client, id: msg.id });
      backend.stdin.write(JSON.stringify({ ...msg, id }) + "\n");
    });
    const drop = () => {
      if (!clients.delete(client)) return;
      for (const [id, p] of pending) if (p.client === client) pending.delete(id);
      log(`client ${client.id} detached (${clients.size} left)`);
    };
    sock.on("close", drop);
    sock.on("error", drop);
  });

  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(path, () => {
      server.off("error", rej);
      res();
    });
  });
  if (process.platform !== "win32") chmodSync(path, 0o600);
  start();

  const close = async () => {
    closing = true;
    for (const c of clients) c.sock.destroy();
    await new Promise<void>((r) => server.close(() => r()));
    const proc = backend;
    if (proc && proc.exitCode === null) {
      proc.stdin?.end(); // the backend closes its agents on stdin EOF
      await new Promise<void>((r) => {
        const t = setTimeout(() => (proc.kill(), r()), 8000);
        proc.once("exit", () => (clearTimeout(t), r()));
      });
    }
    if (process.platform !== "win32") rmSync(path, { force: true });
  };
  return { close, path };
}

/** Is something answering on this socket? */
export function isLive(path: string): Promise<boolean> {
  return new Promise((res) => {
    const s = createConnection(path);
    const t = setTimeout(() => (s.destroy(), res(false)), 1000);
    s.once("connect", () => (clearTimeout(t), s.destroy(), res(true)));
    s.once("error", () => (clearTimeout(t), res(false)));
  });
}

/** Pipe this process's stdin/stdout to the mux socket (what `hive attach` does over SSH). */
export function attachStdio(path: string): Promise<void> {
  return new Promise((res, rej) => {
    const s = createConnection(path);
    s.once("error", rej);
    s.once("connect", () => {
      process.stdin.pipe(s);
      s.pipe(process.stdout);
      process.stdin.once("end", () => s.end());
      s.once("close", () => res());
    });
  });
}

/** Send one control line to a running mux and return its first answer. */
export function control(path: string, cmd: "status" | "stop"): Promise<any> {
  return new Promise((res, rej) => {
    const s = createConnection(path);
    s.once("error", rej);
    s.once("connect", () => s.write(JSON.stringify({ mux: cmd }) + "\n"));
    createInterface({ input: s }).on("line", (l) => {
      try {
        const m = JSON.parse(l);
        if (m.mux) {
          s.destroy();
          res(m);
        }
      } catch {}
    });
  });
}
