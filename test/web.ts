/**
 * hive web: static files with the right types and CSP, no path tricks, the WebSocket
 * only with the project's token and a matching Origin, then the daemon's "ready"
 * and a real RPC through it. If Chromium is around, the phone layout at 390x844 too.
 * Needs the built UI (node scripts/build-ui.mjs); builds it if missing.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { get } from "node:http";
import { join } from "node:path";
import { WebSocket } from "ws";
import { assert, finish, freshDir, until } from "./util.js";

const dir = freshDir(".hive-test-web");
// short home: a unix socket path must stay under ~104 bytes (deep checkouts overflow it)
process.env.HIVE_HOME = mkdtempSync(join(tmpdir(), "hive-web-"));
execFileSync("git", ["init", "-q"], { cwd: dir });
const { startWeb, webToken, WEB_ROOT } = await import("../src/ui/web.js");
const { stopDaemon } = await import("../src/ui/attach.js");
const { projectDir } = await import("../src/core/home.js");
const { isLive, socketPath } = await import("../src/ui/mux.js");
if (!existsSync(join(WEB_ROOT, "index.html"))) execFileSync(process.execPath, ["scripts/build-ui.mjs"], { stdio: "ignore" });

const web = await startWeb({ cwd: dir, port: 0 });
const base = `http://127.0.0.1:${web.port}`;
try {
  assert(web.token === webToken(dir) && web.token.length >= 43, "a per-project random token, the same on every start");
  if (process.platform !== "win32") assert((statSync(join(projectDir(dir), "web-token")).mode & 0o077) === 0, "token file is readable by its owner only");

  // ---- static files ----
  const page = await fetch(base + "/");
  const csp = page.headers.get("content-security-policy") ?? "";
  assert(page.status === 200 && page.headers.get("content-type")?.startsWith("text/html") && (await page.text()).includes("renderer.js"), "/ serves the app page");
  assert(csp.includes("default-src 'none'") && csp.includes("script-src 'self'") && csp.includes("connect-src 'self'") && !csp.includes("*"), "strict CSP: own scripts only, connections to this host only");
  const js = await fetch(base + "/renderer.js");
  assert(js.status === 200 && js.headers.get("content-type")?.startsWith("text/javascript") && js.headers.get("x-content-type-options") === "nosniff", "renderer.js with a JavaScript content type");
  const man = await fetch(base + "/manifest.webmanifest");
  assert(man.status === 200 && man.headers.get("content-type")?.startsWith("application/manifest+json") && (await man.json()).display === "standalone", "PWA manifest (standalone)");
  assert((await fetch(base + "/icons/icon-512.png")).headers.get("content-type") === "image/png", "install icons are PNGs");

  // raw paths: fetch() would tidy the dots away
  const raw = (path: string) => new Promise<number>((res) => get({ host: "127.0.0.1", port: web.port, path }, (r) => (r.resume(), res(r.statusCode ?? 0))).on("error", () => res(0)));
  const tricks = ["/../package.json", "/..%2f..%2fpackage.json", "/%2e%2e/%2e%2e/package.json", "/fonts/", "/fonts", "/.hidden", "/..\\..\\package.json", "/x%00.js"];
  const codes = await Promise.all(tricks.map(raw));
  assert(codes.every((c) => c === 404 || c === 400), `path traversal and directory listing refused (${codes.join(", ")})`);
  assert((await fetch(base + "/", { method: "POST" })).status === 405, "only GET/HEAD");
  assert((await fetch(base + "/auth", { headers: { Authorization: `Bearer ${web.token}` } })).status === 204 && (await fetch(base + "/auth", { headers: { Authorization: "Bearer nope" } })).status === 401, "/auth tells a right key from a wrong one");

  // ---- WebSocket ----
  const origin = base;
  const tryWs = (query: string, o = origin) =>
    new Promise<{ status: number; ws?: WebSocket }>((res) => {
      const ws = new WebSocket(`ws://127.0.0.1:${web.port}/ws${query}`, { headers: { Origin: o } });
      ws.once("open", () => res({ status: 101, ws }));
      ws.once("unexpected-response", (_req, r) => res({ status: r.statusCode ?? 0 }));
      ws.once("error", () => res({ status: 0 }));
    });
  assert((await tryWs("")).status === 401, "WebSocket without a token: 401");
  assert((await tryWs("?t=" + "A".repeat(web.token.length))).status === 401, "WebSocket with a wrong token: 401");
  assert((await tryWs("?t=" + web.token, "https://evil.example")).status === 403, "WebSocket from another Origin: 403 even with the token");
  const ok = await tryWs("?t=" + web.token);
  assert(ok.status === 101 && !!ok.ws, "WebSocket with the token and a matching Origin opens");
  const lines: any[] = [];
  ok.ws!.on("message", (d) => lines.push(JSON.parse(String(d))));
  await until(() => lines.some((l) => l.event === "ready"), 30_000, "ready from the daemon");
  assert(true, "the daemon's ready event arrives over the WebSocket");
  ok.ws!.send(JSON.stringify({ mux: "stop" })); // control lines must not get through
  ok.ws!.send(JSON.stringify({ id: 7, method: "usage", params: {} }));
  await until(() => lines.some((l) => l.id === 7), 15_000, "usage reply");
  const reply = lines.find((l) => l.id === 7);
  assert(!reply.error && Array.isArray(reply.result?.providers), "an RPC (usage) round-trips through hive web and the daemon");
  assert(await isLive(socketPath(dir)), "a mux control line from the browser is dropped (daemon still running)");

  // ---- phone layout in Chromium, when one is installed (skipped on CI runners without it) ----
  let chromium: typeof import("playwright-core").chromium | undefined;
  try {
    chromium = (await import("playwright-core")).chromium;
    const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
    const ready = lines.find((l) => l.event === "ready");
    ok.ws!.send(JSON.stringify({ id: 8, method: "saveLayout", params: { ...ready.layout, panes: [{ name: "m1", kind: "mock", cwd: dir, policy: "ask" }, { name: "m2", kind: "mock", cwd: dir, policy: "ask" }] } }));
    await until(() => lines.some((l) => l.id === 8), 10_000, "saveLayout");
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const p = await ctx.newPage();
    p.on("pageerror", (e) => console.error("[page error]", e.message));
    await p.goto(`${base}/#t=${web.token}`);
    await p.locator(".mnav").waitFor({ timeout: 30_000 });
    assert((await p.locator(".mnav-agent:has-text('m1')").count()) === 1 && (await p.locator(".mnav-agent:has-text('m2')").count()) === 1, "phone: bottom bar lists the agents");
    assert((await p.locator(".pane").count()) === 1 && (await p.locator(".sidebar, .topbar").count()) === 0, "phone: one agent full screen, no sidebar / top bar");
    await p.locator(".mnav-agent:has-text('m2')").click();
    await p.locator('.pane[data-pane="m2"]').waitFor({ timeout: 5000 });
    assert(true, "phone: tapping an agent in the bar shows it");
    assert(!p.url().includes("#t="), "the key is taken out of the address bar");
    await p.locator(".mnav-btn:has-text('Menu')").click();
    await p.locator(".msheet").waitFor({ timeout: 5000 });
    await p.goBack();
    await p.locator(".msheet").waitFor({ state: "detached", timeout: 5000 });
    assert(true, "phone: Back closes the open sheet");
    if (process.env.SHOT_DIR) await p.screenshot({ path: join(process.env.SHOT_DIR, "web-phone.png") });
    await b.close();
  } catch (e: any) {
    if (chromium && /Executable doesn't exist|browserType.launch/.test(String(e?.message))) console.log(`⏭  phone layout check skipped (no Chromium: ${String(e.message).split("\n")[0]})`);
    else throw e;
  }
  ok.ws!.close();
} finally {
  await web.close();
  await stopDaemon(dir);
}
finish("web");
