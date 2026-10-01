/**
 * `hive web`: the pane UI in a browser (phone, tablet, another PC), for a project
 * whose hive runs on this machine.
 *
 *   browser ⇄ (WebSocket, wss via tailscale serve) ⇄ hive web ⇄ (NDJSON over the local socket) ⇄ hive daemon
 *
 * Listens on 127.0.0.1 only, like everything else in hive: nothing is reachable
 * from the network until you run `tailscale serve --bg 7777`, which publishes it
 * over HTTPS to your own tailnet (your devices, nobody else). On top of that the
 * WebSocket needs the project's random token (32 bytes, kept owner-only in the
 * project's state dir) and an Origin that matches the Host, so a web page in your
 * phone's browser can't talk to your hive even if it guesses the address.
 *
 * The static files are the same renderer the desktop app uses, built with a
 * WebSocket bridge instead of Electron's preload (dist-ui/web, `npm run ui:build`).
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { projectDir } from "../core/home.js";
import { ensureDaemon } from "./attach.js";

export const DEFAULT_PORT = 7777;

/** The built web UI: dist-ui/web next to src/ and dist/. */
export const WEB_ROOT = fileURLToPath(new URL("../../dist-ui/web", import.meta.url));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** The project's web token: created on first use, readable by you only. */
export function webToken(cwd: string, rotate = false): string {
  const dir = projectDir(cwd);
  const file = join(dir, "web-token");
  if (!rotate && existsSync(file)) {
    const t = readFileSync(file, "utf8").trim();
    if (/^[A-Za-z0-9_-]{40,}$/.test(t)) return t;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const t = randomBytes(32).toString("base64url");
  writeFileSync(file, t + "\n", { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(file, 0o600); // an older file keeps its mode otherwise
  return t;
}

/** Constant-time compare (lengths differ → still compare something, then fail). */
export function tokenOk(given: string | null | undefined, token: string): boolean {
  const a = Buffer.from(given ?? "");
  const b = Buffer.from(token);
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** The Origin a browser sends must be this server as the browser sees it (Host, or the proxy's forwarded host). */
function originOk(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const fwd = String(req.headers["x-forwarded-host"] ?? "").split(",")[0].trim().toLowerCase();
  return host === String(req.headers.host ?? "").toLowerCase() || (!!fwd && host === fwd);
}

function csp(req: IncomingMessage): string {
  // 'self' covers ws(s) to the same host in current browsers; name it too for older WebViews
  const host = String(req.headers.host ?? "");
  const ws = /^[A-Za-z0-9.-]+(:\d+)?$/.test(host) ? ` wss://${host} ws://${host}` : "";
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${ws}`,
    "manifest-src 'self'",
    "worker-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export interface WebOptions {
  cwd: string;
  port?: number;
  /** Where the built web UI is (tests point this elsewhere). */
  root?: string;
  /** Socket of the project's daemon; started on demand. */
  daemon?: (cwd: string) => Promise<string>;
  token?: string;
  log?: (s: string) => void;
}

export interface WebServer {
  port: number;
  token: string;
  close: () => Promise<void>;
}

export async function startWeb(o: WebOptions): Promise<WebServer> {
  const root = resolve(o.root ?? WEB_ROOT);
  if (!existsSync(join(root, "index.html"))) throw new Error(`the web UI isn't built (${root} is missing); run: npm run ui:build`);
  const token = o.token ?? webToken(o.cwd);
  const daemon = o.daemon ?? ensureDaemon;
  const log = o.log ?? (() => {});

  const server = createServer((req, res) => {
    try {
      serve(req, res);
    } catch (e: any) {
      log(`web: ${e?.message ?? e}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });

  const baseHeaders = (req: IncomingMessage) => ({
    "Content-Security-Policy": csp(req),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Opener-Policy": "same-origin",
  });

  function serve(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://x");
    // Does this token work? (The page asks when its WebSocket never opens, to tell "wrong key" from "offline".)
    if (url.pathname === "/auth") {
      const auth = String(req.headers.authorization ?? "");
      const ok = auth.startsWith("Bearer ") && tokenOk(auth.slice(7), token);
      res.writeHead(ok ? 204 : 401, { ...baseHeaders(req), "Cache-Control": "no-store" });
      return void res.end();
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { ...baseHeaders(req), Allow: "GET, HEAD" });
      return void res.end();
    }
    const notFound = () => {
      res.writeHead(404, { ...baseHeaders(req), "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found\n");
    };
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return notFound();
    }
    if (path === "/") path = "/index.html";
    // no dot-files, no "..", no backslashes or NULs: only plain paths under the web root
    if (/(^|\/)\.|\\|\0/.test(path)) return notFound();
    const file = resolve(root, "." + path);
    if (!file.startsWith(root + sep)) return notFound();
    const type = TYPES[extname(file).toLowerCase()];
    if (!type) return notFound();
    let st;
    try {
      st = statSync(file);
    } catch {
      return notFound();
    }
    if (!st.isFile()) return notFound(); // no directory listings
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    const headers = { ...baseHeaders(req), "Content-Type": type, ETag: etag, "Cache-Control": "no-cache" };
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, headers);
      return void res.end();
    }
    res.writeHead(200, { ...headers, "Content-Length": st.size });
    if (req.method === "HEAD") return void res.end();
    res.end(readFileSync(file));
  }

  // ---- WebSocket: one daemon connection per browser tab ----
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  server.on("upgrade", (req, sock, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    const refuse = (code: number, why: string) => {
      log(`web: refused a connection (${why})`);
      sock.end(`HTTP/1.1 ${code} ${code === 401 ? "Unauthorized" : code === 403 ? "Forbidden" : "Not Found"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (url.pathname !== "/ws") return refuse(404, "path");
    if (!originOk(req)) return refuse(403, `origin ${req.headers.origin ?? "missing"} isn't ${req.headers.host}`);
    if (!tokenOk(url.searchParams.get("t"), token)) return refuse(401, "wrong or missing token");
    wss.handleUpgrade(req, sock, head, (ws) => void relay(ws));
  });

  async function relay(ws: WebSocket) {
    let path: string;
    try {
      path = await daemon(o.cwd);
    } catch (e: any) {
      ws.close(1011, String(e?.message ?? e).slice(0, 120));
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    const up = createConnection(path);
    log("web: client connected");
    createInterface({ input: up })
      .on("line", (line) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(line);
      })
      .on("error", () => {});
    up.on("error", () => {});
    up.on("close", () => ws.close(1012, "hive restarting"));
    ws.on("message", (data, binary) => {
      if (binary) return;
      for (const line of String(data).split("\n")) {
        if (!line.trim()) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        // only app requests; the daemon's control lines (`hive attach --stop`) stay local
        if (typeof msg?.id !== "number" || typeof msg.method !== "string") continue;
        if (up.writable) up.write(JSON.stringify(msg) + "\n");
      }
    });
    // phones drop off Wi-Fi without closing: ping, and let go of a tab that stops answering
    let alive = true;
    ws.on("pong", () => (alive = true));
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 30_000);
    ws.on("close", () => {
      clearInterval(ping);
      up.end();
      log("web: client disconnected");
    });
  }

  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(o.port ?? DEFAULT_PORT, "127.0.0.1", () => {
      server.off("error", rej);
      res();
    });
  });
  const port = (server.address() as { port: number }).port;
  return {
    port,
    token,
    close: async () => {
      for (const c of wss.clients) c.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** This machine's name on the tailnet (what `tailscale serve` publishes), if Tailscale is running. */
export function tailnetName(): Promise<string | undefined> {
  return new Promise((res) => {
    execFile("tailscale", ["status", "--json", "--peers=false"], { timeout: 4000, windowsHide: true }, (err, out) => {
      if (err) return res(undefined);
      try {
        const name = String(JSON.parse(out)?.Self?.DNSName ?? "").replace(/\.$/, "");
        res(name || undefined);
      } catch {
        res(undefined);
      }
    });
  });
}

/** Foreground `hive web`: start the daemon, serve, print where to open it. */
export async function runWeb(cwd: string, opts: { port?: number; rotate?: boolean } = {}): Promise<void> {
  const log = (s: string) => process.stderr.write(s.endsWith("\n") ? s : s + "\n");
  const token = webToken(cwd, opts.rotate);
  await ensureDaemon(cwd); // fail now, not on the phone, if the project's hive can't start
  const w = await startWeb({ cwd, port: opts.port, token, log });
  const name = await tailnetName();
  const tty = process.stdout.isTTY;
  const b = (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
  const d = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
  console.log(`hive web for ${cwd}`);
  console.log(`  on this machine:  http://127.0.0.1:${w.port}/#t=${token}`);
  if (name) {
    console.log(`  on your phone:    ${b(`https://${name}/#t=${token}`)}`);
    console.log(d(`  (needs, once: tailscale serve --bg ${w.port}  — HTTPS on your tailnet only; undo with: tailscale serve --https=443 off)`));
  } else {
    console.log(d(`  phone: install Tailscale here and on the phone, run \`tailscale serve --bg ${w.port}\`, then open https://<this machine>.<tailnet>.ts.net/#t=${token}`));
  }
  console.log(d("  The #t=… part is the key to this project's hive: anyone with it on your tailnet can drive your agents. New key: hive web --new-token"));
  console.log(d("  Agents keep running when you close this (hive attach --stop ends them). Ctrl+C stops the web server."));
  const stop = () => void w.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
