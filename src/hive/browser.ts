/**
 * Sandboxed browser: a Chromium that hive runs itself (playwright-core), never
 * the owner's own browser. It has its own profile — in memory by default, or a
 * dedicated folder in the project's state dir when "keep logins for this
 * project" is on — so pages it opens never see the owner's cookies or logins.
 *
 * It lives in the hub process (the UI backend or `hive serve`), so it works the
 * same on a desktop and on a server viewed from a phone. The owner watches it as
 * a stream of JPEG frames (CDP screencast, capped fps, stopped when nobody
 * watches) and drives it with forwarded mouse and keyboard input; agents drive
 * it through hive_browser_* tools (devices.ts). Page content is untrusted.
 *
 * Only http(s) pages open; localhost is allowed (testing dev servers is the
 * point) except the hive web port (HIVE_WEB_PORT), so a page can't reach hive itself.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir, hostname, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright-core";

export interface BrowserState {
  /** A Chromium was found (or one is running). */
  available: boolean;
  running: boolean;
  url: string;
  title: string;
  /** Keep logins: the profile is a folder in the project's state dir. */
  persistent: boolean;
  /** Page size in CSS pixels (frames map onto this). */
  width: number;
  height: number;
  error?: string;
  help?: string;
}

export interface Frame {
  mime: string;
  /** base64 */
  data: string;
  w: number;
  h: number;
}

export const NO_CHROMIUM =
  "No Chromium found for the sandboxed browser. Install one with `npx playwright install chromium` (or install Google Chrome / Microsoft Edge), or set HIVE_CHROMIUM to a Chromium/Chrome executable.";

const MAX_FPS = 8;
const MAX_TEXT = 20_000;

/** Find a Chromium-family executable. Playwright's downloads first; `system` adds installed Chrome/Edge. */
export function findChromium(o: { system?: boolean } = {}): string | undefined {
  const env = process.env;
  const isFile = (p: string) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (env.HIVE_CHROMIUM && isFile(env.HIVE_CHROMIUM)) return env.HIVE_CHROMIUM;
  const win = process.platform === "win32";
  const mac = process.platform === "darwin";
  const cacheRoots = [
    env.PLAYWRIGHT_BROWSERS_PATH,
    "/opt/pw-browsers",
    win ? join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "ms-playwright") : mac ? join(homedir(), "Library", "Caches", "ms-playwright") : join(homedir(), ".cache", "ms-playwright"),
  ].filter((r): r is string => !!r && r !== "0");
  const inside = ["chrome-linux/chrome", "chrome-linux64/chrome", "chrome-win/chrome.exe", "chrome-win64/chrome.exe", "chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium"];
  for (const root of cacheRoots) {
    if (isFile(join(root, "chromium"))) return join(root, "chromium");
    let dirs: string[] = [];
    try {
      dirs = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d));
    } catch {
      continue;
    }
    dirs.sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const d of dirs) for (const rel of inside) if (isFile(join(root, d, rel))) return join(root, d, rel);
  }
  if (o.system === false) return undefined;
  const pf = [env["ProgramFiles(x86)"], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean) as string[];
  const system = win
    ? pf.flatMap((p) => [join(p, "Microsoft", "Edge", "Application", "msedge.exe"), join(p, "Google", "Chrome", "Application", "chrome.exe")])
    : mac
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
      : ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/microsoft-edge", "/snap/bin/chromium"];
  return system.find(isFile);
}

/** Ports on this machine a page must not reach (the hive web client). */
export function blockedPorts(): number[] {
  return (process.env.HIVE_WEB_PORT ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
}

let localNames: Set<string> | undefined;
/** Host names and addresses that mean "this machine". */
function isLocalHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0" || h === "::" || h === "::1" || /^127\./.test(h) || /^::ffff:127\./.test(h)) return true;
  if (!localNames) {
    localNames = new Set([hostname().toLowerCase()]);
    for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) localNames.add(a.address.toLowerCase());
  }
  return localNames.has(h);
}

/** Why this URL may not load, or undefined if it may. */
export function urlProblem(u: URL, ports = blockedPorts()): string | undefined {
  if (u.protocol !== "http:" && u.protocol !== "https:") return `only http(s) pages can be opened (not ${u.protocol})`;
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  if (ports.includes(port) && isLocalHost(u.hostname)) return `port ${port} on this machine is hive's own web port`;
  return undefined;
}

/** "example.com" → https://example.com/, "localhost:3000" → http://localhost:3000/; refuses non-http(s). */
export function normalizeUrl(raw: string, ports = blockedPorts()): string {
  let s = String(raw ?? "").trim();
  if (!s) throw new Error("url is empty");
  if (s.length > 4000) throw new Error("url is too long");
  const hostPort = /^([\w.-]+|\[[\da-f:]+\]):\d+(?:[/?#]|$)/i.exec(s);
  if (hostPort || !/^[a-z][a-z\d+.-]*:/i.test(s)) {
    const host = (hostPort?.[1] ?? s.split(/[/:?#]/)[0]) || "";
    s = (isLocalHost(host) ? "http://" : "https://") + s;
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`not a valid URL: ${raw}`);
  }
  const p = urlProblem(u, ports);
  if (p) throw new Error(`refused: ${p}`);
  return u.href;
}

/** Collapse whitespace runs and blank lines in page text. */
export function tidyText(s: string, max = MAX_TEXT): string {
  const t = s
    .replace(/\r/g, "")
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return t.length > max ? `${t.slice(0, max)}\n… (${t.length - max} more characters; read a narrower selector)` : t;
}

async function loadPlaywright(): Promise<typeof import("playwright-core")> {
  try {
    return await import("playwright-core");
  } catch {
    throw new Error("the sandboxed browser needs the playwright-core package (npm install playwright-core)");
  }
}

export interface SandboxBrowserOptions {
  /** Folder for the "keep logins" profile. */
  profileDir: string;
  persistent?: boolean;
  executablePath?: string;
  headless?: boolean;
  viewport?: { width: number; height: number };
  /** Close Chromium after this long unused and unwatched (default 30 min; 0 = never). */
  idleMs?: number;
}

/**
 * One page in a separate Chromium. Emits "frame" (Frame) while watched and
 * "state" (BrowserState) when the URL, title or running state changes.
 */
export class SandboxBrowser extends EventEmitter {
  private browser?: Browser;
  private ctx?: BrowserContext;
  private pageRef?: Page;
  private cdp?: CDPSession;
  private launching?: Promise<Page>;
  private fps = 0;
  private lastFrameAt = 0;
  private lastFrame?: Frame;
  private pendingFrame?: Frame;
  private frameTimer?: NodeJS.Timeout;
  private shotTimer?: NodeJS.Timeout;
  private idleTimer?: NodeJS.Timeout;
  private lastUse = Date.now();
  private error?: string;
  persistent: boolean;
  readonly viewport: { width: number; height: number };

  constructor(private o: SandboxBrowserOptions) {
    super();
    this.persistent = !!o.persistent;
    this.viewport = o.viewport ?? { width: 1280, height: 800 };
    const idle = o.idleMs ?? 30 * 60_000;
    if (idle > 0) {
      this.idleTimer = setInterval(() => {
        if (this.running && this.fps === 0 && Date.now() - this.lastUse > idle) void this.close();
      }, Math.min(idle, 60_000));
      this.idleTimer.unref?.();
    }
  }

  get running(): boolean {
    return !!this.pageRef && !this.pageRef.isClosed();
  }

  state(): BrowserState {
    const exe = this.o.executablePath ?? findChromium();
    const p = this.running ? this.pageRef : undefined;
    return {
      available: !!exe || this.running,
      running: this.running,
      url: p?.url() ?? "",
      title: this.title,
      persistent: this.persistent,
      width: this.viewport.width,
      height: this.viewport.height,
      error: this.error,
      help: exe || this.running ? undefined : NO_CHROMIUM,
    };
  }
  private title = "";

  private emitState() {
    this.emit("state", this.state());
  }

  /** The page, launching Chromium if needed. */
  async page(): Promise<Page> {
    this.lastUse = Date.now();
    if (this.running) return this.pageRef!;
    this.launching ??= this.launch().finally(() => (this.launching = undefined));
    return this.launching;
  }

  private async launch(): Promise<Page> {
    const pw = await loadPlaywright();
    const executablePath = this.o.executablePath ?? findChromium();
    if (!executablePath) throw new Error(NO_CHROMIUM);
    const args = ["--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-extensions", "--disable-background-networking", "--mute-audio"];
    const headless = this.o.headless ?? true;
    const ctxOpts = { viewport: this.viewport, acceptDownloads: false, serviceWorkers: "block" as const };
    this.error = undefined;
    try {
      if (this.persistent) {
        mkdirSync(this.o.profileDir, { recursive: true });
        this.ctx = await pw.chromium.launchPersistentContext(this.o.profileDir, { executablePath, headless, args, ...ctxOpts });
      } else {
        this.browser = await pw.chromium.launch({ executablePath, headless, args });
        this.ctx = await this.browser.newContext(ctxOpts);
      }
    } catch (e: any) {
      this.error = String(e?.message ?? e).split("\n")[0].slice(0, 300);
      this.emitState();
      throw new Error(`could not start Chromium (${executablePath}): ${this.error}`);
    }
    const ctx = this.ctx;
    // Every request, redirect and subresource: no file:, no hive web port.
    await ctx.route(
      (u) => !!urlProblem(u),
      (r) => r.abort("blockedbyclient"),
    );
    ctx.on("close", () => this.reset());
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    this.pageRef = page;
    for (const extra of ctx.pages()) if (extra !== page) await extra.close().catch(() => {});
    // One page per pane: a popup (target=_blank, window.open) loads in the main page instead.
    ctx.on("page", (p) => {
      if (p === page) return;
      void (async () => {
        await p.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
        const u = p.url();
        await p.close().catch(() => {});
        if (u && u !== "about:blank" && this.pageRef && !urlProblem(new URL(u))) await this.pageRef.goto(u).catch(() => {});
      })();
    });
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame()) void this.refreshTitle();
    });
    page.on("load", () => void this.refreshTitle());
    // alert/confirm/prompt would block the page (and an agent) forever.
    page.on("dialog", (d) => void (d.type() === "beforeunload" ? d.accept() : d.dismiss()).catch(() => {}));
    page.on("close", () => {
      if (this.pageRef === page) this.reset();
    });
    if (this.fps > 0) await this.startStream();
    this.emitState();
    return page;
  }

  private async refreshTitle() {
    const t = await this.pageRef?.title().catch(() => "");
    this.title = t ?? "";
    this.emitState();
  }

  private reset() {
    const was = !!this.pageRef;
    this.pageRef = undefined;
    this.cdp = undefined;
    this.ctx = undefined;
    this.title = "";
    this.lastFrame = undefined;
    clearInterval(this.shotTimer);
    clearTimeout(this.frameTimer);
    this.shotTimer = this.frameTimer = undefined;
    const b = this.browser;
    this.browser = undefined;
    void b?.close().catch(() => {});
    if (was) this.emitState();
  }

  async close() {
    const ctx = this.ctx;
    const b = this.browser;
    this.reset();
    await ctx?.close().catch(() => {});
    await b?.close().catch(() => {});
  }

  /** Switch between an in-memory profile and the project's "keep logins" profile (restarts Chromium). */
  async setPersistent(on: boolean) {
    if (on === this.persistent) return;
    const url = this.running ? this.pageRef!.url() : "";
    await this.close();
    this.persistent = on;
    this.emitState();
    if (url && /^https?:/.test(url)) await this.open(url).catch(() => {});
  }

  /** Dispose for good (hub shutdown). */
  async dispose() {
    clearInterval(this.idleTimer);
    this.removeAllListeners();
    await this.close();
  }

  // ---- streaming ----

  /** Stream frames at up to `fps` (0 stops). Re-sends the last frame so a new watcher sees something at once. */
  async watch(fps: number) {
    this.fps = Math.max(0, Math.min(MAX_FPS, fps));
    if (this.fps === 0) return this.stopStream();
    if (this.lastFrame) this.emit("frame", this.lastFrame);
    if (this.running) await this.startStream();
  }

  private pushFrame(f: Frame) {
    this.lastFrame = f;
    const gap = 1000 / Math.max(1, this.fps);
    const wait = this.lastFrameAt + gap - Date.now();
    if (wait <= 0) {
      this.lastFrameAt = Date.now();
      this.emit("frame", f);
      return;
    }
    // keep the newest frame and send it when the cap allows (the last frame of a burst is never lost)
    this.pendingFrame = f;
    this.frameTimer ??= setTimeout(() => {
      this.frameTimer = undefined;
      const p = this.pendingFrame;
      this.pendingFrame = undefined;
      if (p && this.fps > 0) {
        this.lastFrameAt = Date.now();
        this.emit("frame", p);
      }
    }, wait);
  }

  private async startStream() {
    const page = this.pageRef;
    if (!page || this.cdp || this.shotTimer) return;
    try {
      const cdp = await page.context().newCDPSession(page);
      this.cdp = cdp;
      cdp.on("Page.screencastFrame", (f: any) => {
        void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
        if (this.fps > 0) this.pushFrame({ mime: "image/jpeg", data: f.data, w: Math.round(f.metadata?.deviceWidth ?? this.viewport.width), h: Math.round(f.metadata?.deviceHeight ?? this.viewport.height) });
      });
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: this.viewport.width, maxHeight: this.viewport.height, everyNthFrame: 1 });
    } catch {
      // Not Chromium-over-CDP: poll screenshots instead.
      this.cdp = undefined;
      this.shotTimer = setInterval(() => {
        const p = this.pageRef;
        if (!p || this.fps === 0) return;
        void p
          .screenshot({ type: "jpeg", quality: 60 })
          .then((b) => this.pushFrame({ mime: "image/jpeg", data: b.toString("base64"), w: this.viewport.width, h: this.viewport.height }))
          .catch(() => {});
      }, 1000 / Math.max(1, this.fps));
    }
  }

  private stopStream() {
    clearInterval(this.shotTimer);
    this.shotTimer = undefined;
    const cdp = this.cdp;
    this.cdp = undefined;
    if (cdp) void cdp.send("Page.stopScreencast").then(() => cdp.detach()).catch(() => {});
  }

  // ---- actions (agents and the owner) ----

  async open(url: string): Promise<BrowserState> {
    const href = normalizeUrl(url);
    const page = await this.page();
    try {
      await page.goto(href, { waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch (e: any) {
      throw new Error(`could not load ${href}: ${String(e?.message ?? e).split("\n")[0].slice(0, 300)}`);
    }
    await this.refreshTitle();
    return this.state();
  }

  async nav(action: "back" | "forward" | "reload" | "stop"): Promise<BrowserState> {
    const page = await this.page();
    const o = { waitUntil: "domcontentloaded" as const, timeout: 30_000 };
    if (action === "back") await page.goBack(o).catch(() => null);
    else if (action === "forward") await page.goForward(o).catch(() => null);
    else if (action === "reload") await page.reload(o).catch(() => null);
    else await page.evaluate(() => window.stop()).catch(() => {});
    await this.refreshTitle();
    return this.state();
  }

  private async settle(page: Page) {
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    await this.refreshTitle();
  }

  async click(t: { selector?: string; x?: number; y?: number }): Promise<string> {
    const page = await this.page();
    if (t.selector) {
      await page.locator(checkSelector(t.selector)).first().click({ timeout: 10_000 });
    } else if (Number.isFinite(t.x) && Number.isFinite(t.y)) {
      await page.mouse.click(this.clampX(t.x!), this.clampY(t.y!));
    } else throw new Error("give a selector, or x and y");
    await this.settle(page);
    return `clicked ${t.selector ?? `(${Math.round(t.x!)}, ${Math.round(t.y!)})`}; page is now ${page.url()}`;
  }

  async type(selector: string, text: string, submit = false): Promise<string> {
    const page = await this.page();
    const loc = page.locator(checkSelector(selector)).first();
    try {
      await loc.fill(text, { timeout: 10_000 });
    } catch {
      // not an input/textarea/contenteditable: click it and type
      await loc.click({ timeout: 10_000 });
      await page.keyboard.type(text);
    }
    if (submit) {
      await loc.press("Enter").catch(() => page.keyboard.press("Enter"));
      await this.settle(page);
    }
    return `typed ${text.length} characters into ${selector}${submit ? " and pressed Enter" : ""}; page is ${page.url()}`;
  }

  /** Visible text (raw; the caller wraps it as untrusted). */
  async read(selector?: string): Promise<{ url: string; title: string; text: string }> {
    const page = await this.page();
    const text = await page.locator(selector ? checkSelector(selector) : "body").first().innerText({ timeout: 10_000 });
    return { url: page.url(), title: await page.title().catch(() => ""), text: tidyText(text) };
  }

  async screenshot(path: string, fullPage = false): Promise<string> {
    const page = await this.page();
    mkdirSync(dirname(path), { recursive: true });
    await page.screenshot({ path, type: "png", fullPage });
    return path;
  }

  private clampX = (x: number) => Math.max(0, Math.min(this.viewport.width - 1, x));
  private clampY = (y: number) => Math.max(0, Math.min(this.viewport.height - 1, y));

  /** Mouse / keyboard from the owner's pane (coordinates in page CSS pixels). */
  async input(e: BrowserInput) {
    if (!this.running) return;
    const page = this.pageRef!;
    this.lastUse = Date.now();
    const x = this.clampX(Number(e.x) || 0);
    const y = this.clampY(Number(e.y) || 0);
    const button = e.button === "right" ? "right" : e.button === "middle" ? "middle" : "left";
    switch (e.type) {
      case "move":
        return page.mouse.move(x, y);
      case "down":
        await page.mouse.move(x, y);
        return page.mouse.down({ button });
      case "up":
        await page.mouse.move(x, y);
        return page.mouse.up({ button });
      case "click":
        return page.mouse.click(x, y, { button });
      case "wheel":
        await page.mouse.move(x, y);
        return page.mouse.wheel(Math.max(-5000, Math.min(5000, Number(e.dx) || 0)), Math.max(-5000, Math.min(5000, Number(e.dy) || 0)));
      case "key": {
        const key = String(e.key ?? "");
        if (!key || key.length > 30 || ["Shift", "Control", "Alt", "Meta"].includes(key)) return;
        const mods = (e.mods ?? []).filter((m) => ["Control", "Shift", "Alt", "Meta"].includes(m));
        const combo = [...new Set(mods)].join("+");
        try {
          return await page.keyboard.press(combo ? `${combo}+${key}` : key);
        } catch {
          // a character outside the US layout (é, ß, emoji): type it as text
          if (!combo || combo === "Shift") return page.keyboard.insertText(key);
        }
        return;
      }
      case "text":
        return page.keyboard.insertText(String(e.text ?? "").slice(0, 10_000));
    }
  }
}

export interface BrowserInput {
  type: "move" | "down" | "up" | "click" | "wheel" | "key" | "text";
  x?: number;
  y?: number;
  button?: "left" | "right" | "middle";
  dx?: number;
  dy?: number;
  key?: string;
  mods?: string[];
  text?: string;
}

/** Playwright selectors (css, text=, role=, xpath); bounded, never a JS expression. */
function checkSelector(s: string): string {
  const t = String(s ?? "").trim();
  if (!t) throw new Error("selector is empty");
  if (t.length > 500) throw new Error("selector is longer than 500 characters");
  if (/^\s*(js|javascript|_react|_vue)\s*=/i.test(t)) throw new Error("that selector engine is not allowed");
  return t;
}
