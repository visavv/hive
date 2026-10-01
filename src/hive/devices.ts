/**
 * Device panes in one place: the sandboxed browser (browser.ts) and the
 * Android device (android.ts), owned by the hub process. Agents' hive_browser_*
 * and hive_android_* tools queue requests in the db (device_jobs); the hub
 * claims them and runs them here, so there is one browser and one adb client
 * per hive, the same ones the owner watches in the panes.
 *
 * Files agents get (screenshots) are saved under <agent folder>/out/browser
 * or out/android; an APK to install must be inside the agent's folder.
 * Text from pages and apps is wrapped as untrusted.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SandboxBrowser, findChromium, type BrowserState, type Frame } from "./browser.js";
import { AndroidHost, findAdb } from "./android.js";
import { untrusted } from "../core/trust.js";
import { confine } from "../core/confine.js";
import type { HiveDb } from "./db.js";

export type DeviceKind = "browser" | "android";

/** What a device job returns to the agent's MCP server (JSON in device_jobs.result). */
export interface DeviceResult {
  text: string;
  /** A PNG the MCP server attaches as image content. */
  image?: string;
}

const PERSIST_KEY = "browser.persistent";

function shotPath(cwd: string, sub: string, name?: string): string {
  const dir = join(resolve(cwd), "out", sub);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const slug = (name ?? "").toLowerCase().replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return join(dir, `${stamp}${slug ? "-" + slug : ""}-${Math.random().toString(36).slice(2, 6)}.png`);
}

/**
 * Emits "frame" (device, Frame), "state" (device, state) and "activity"
 * (device, agent, action) when an agent uses a device, so the UI can open its pane.
 */
export class Devices extends EventEmitter {
  readonly browser: SandboxBrowser;
  readonly android: AndroidHost;

  constructor(private o: { projectDir: string; db?: HiveDb; executablePath?: string; headless?: boolean }) {
    super();
    let persistent = false;
    try {
      persistent = o.db?.getSetting(PERSIST_KEY) === "1";
    } catch {}
    this.browser = new SandboxBrowser({ profileDir: join(o.projectDir, "browser-profile"), persistent, executablePath: o.executablePath, headless: o.headless });
    this.android = new AndroidHost();
    this.browser.on("frame", (f: Frame) => this.emit("frame", "browser", f));
    this.browser.on("state", (s: BrowserState) => this.emit("state", "browser", s));
    this.android.on("frame", (f: Frame) => this.emit("frame", "android", f));
    this.android.on("state", (s) => this.emit("state", "android", s));
    this.android.on("problem", (msg: string) => this.emit("problem", "android", msg));
  }

  /** Device tools this hub can offer agents (browser when a Chromium is found, android when adb is). */
  static kinds(): DeviceKind[] {
    return [...(findChromium() ? (["browser"] as const) : []), ...(findAdb() ? (["android"] as const) : [])];
  }

  async setPersistent(on: boolean) {
    try {
      this.o.db?.setSetting(PERSIST_KEY, on ? "1" : null);
    } catch {}
    await this.browser.setPersistent(on);
  }

  async dispose() {
    this.android.dispose();
    await this.browser.dispose();
    this.removeAllListeners();
  }

  /** Run one agent request. `cwd` is the agent's folder as the hub knows it. */
  async run(agent: string, cwd: string, kind: string, p: any): Promise<DeviceResult> {
    const [device, action] = kind.split("_", 2) as [string, string];
    if (device === "browser" || device === "android") this.emit("activity", device, agent, action);
    const b = this.browser;
    const a = this.android;
    const str = (v: unknown, what: string) => {
      if (typeof v !== "string") throw new Error(`${what} is required`);
      return v;
    };
    switch (kind) {
      case "browser_open": {
        const s = await b.open(str(p.url, "url"));
        return { text: `opened ${s.url}\ntitle: ${untrusted("page title", s.title)}` };
      }
      case "browser_nav":
        return { text: `now at ${(await b.nav(p.action)).url}` };
      case "browser_click":
        return { text: await b.click({ selector: p.selector, x: p.x, y: p.y }) };
      case "browser_type":
        return { text: await b.type(str(p.selector, "selector"), str(p.text, "text"), !!p.submit) };
      case "browser_read": {
        const r = await b.read(p.selector);
        return { text: `url: ${r.url}\n${untrusted(`text of the web page ${r.url}${p.selector ? ` (${p.selector})` : ""}`, `title: ${r.title}\n\n${r.text}`)}` };
      }
      case "browser_screenshot": {
        const path = await b.screenshot(shotPath(cwd, "browser", p.name), !!p.full_page);
        return { text: `saved ${path} (page ${b.state().url})`, image: path };
      }
      case "android_devices": {
        const st = await a.state();
        if (!st.adb) return { text: st.help ?? "adb not found" };
        const rows = st.devices.map((d) => `${d.serial}\t${d.state}${d.model ? `\t${d.model}` : ""}${d.serial === st.selected ? "\t(selected)" : ""}`);
        return { text: rows.length ? rows.join("\n") : `no devices connected${st.avds.length ? `; emulators you can start from the Android pane: ${st.avds.join(", ")}` : ""}` };
      }
      case "android_screenshot": {
        const png = await a.screencap(p.device);
        const path = shotPath(cwd, "android", p.name);
        writeFileSync(path, png);
        return { text: `saved ${path}`, image: path };
      }
      case "android_tap":
        await a.tap(p.x, p.y, p.device);
        return { text: `tapped (${Math.round(p.x)}, ${Math.round(p.y)})` };
      case "android_swipe":
        await a.swipe(p.x1, p.y1, p.x2, p.y2, p.duration_ms, p.device);
        return { text: "swiped" };
      case "android_type":
        await a.text(str(p.text, "text"), p.device);
        return { text: `typed ${p.text.length} characters` };
      case "android_key":
        await a.key(p.key, p.device);
        return { text: `pressed ${p.key}` };
      case "android_install":
        // Only an APK inside the agent's own folder (the owner can install any path from the pane).
        return { text: await a.install(confine(cwd, str(p.apk, "apk")), p.device) };
      case "android_launch":
        return { text: await a.launch(str(p.package, "package"), p.device) };
      case "android_ui_dump":
        return { text: untrusted("screen contents of the Android app (uiautomator)", await a.uiDump(p.device)) };
    }
    throw new Error(`unknown device action ${kind}`);
  }
}
