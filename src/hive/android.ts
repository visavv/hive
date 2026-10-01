/**
 * Android device pane and agent tools over adb: an emulator or a phone on USB / Wi-Fi.
 *
 * adb is found on PATH, in $ANDROID_HOME / $ANDROID_SDK_ROOT /platform-tools, or
 * in Android Studio's default SDK folder (or set HIVE_ADB). The screen is polled
 * with `adb exec-out screencap -p` at a capped rate while someone watches;
 * taps, swipes, text and keys go through `adb shell input …`.
 *
 * adb shell joins its arguments with spaces and hands the result to the
 * device's sh, so nothing from an agent or the UI reaches it unvalidated:
 * numbers are checked, package names and key names must match strict
 * patterns, and text is single-quoted for the device shell (spaces as %s,
 * which `input text` turns back into spaces). No arbitrary shell is ever run.
 */
import { EventEmitter } from "node:events";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";

export interface AndroidDevice {
  serial: string;
  /** device | offline | unauthorized | … */
  state: string;
  model?: string;
  product?: string;
  transport?: string;
}

export interface AndroidState {
  adb: string | null;
  emulator: string | null;
  help?: string;
  devices: AndroidDevice[];
  avds: string[];
  selected?: string;
  error?: string;
}

export const NO_ADB =
  "adb (Android platform-tools) was not found. Install Android Studio (it includes the emulator and adb) or the standalone platform-tools, then add the platform-tools folder to PATH or set ANDROID_HOME (see docs/DEVICES.md).";

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

function sdkRoots(): string[] {
  const env = process.env;
  return [
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    process.platform === "win32"
      ? join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Android", "Sdk")
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Android", "sdk")
        : join(homedir(), "Android", "Sdk"),
  ].filter((r): r is string => !!r);
}

function onPath(name: string): string | undefined {
  const exts = process.platform === "win32" ? [".exe", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) if (isFile(join(dir, name + ext))) return join(dir, name + ext);
  }
  return undefined;
}

const exe = (n: string) => (process.platform === "win32" ? `${n}.exe` : n);

/** The adb binary, or undefined when it isn't installed. */
export function findAdb(): string | undefined {
  if (process.env.HIVE_ADB) return isFile(process.env.HIVE_ADB) ? process.env.HIVE_ADB : undefined;
  return onPath("adb") ?? sdkRoots().map((r) => join(r, "platform-tools", exe("adb"))).find(isFile);
}

/** The Android emulator binary, if the SDK has one. */
export function findEmulator(): string | undefined {
  return sdkRoots().map((r) => join(r, "emulator", exe("emulator"))).find(isFile) ?? onPath("emulator");
}

// ---- argument building (pure; unit-tested) ----

const SERIAL = /^[\w.:\-]{1,100}$/;
const PACKAGE = /^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$/;
const AVD = /^[\w.\-]{1,100}$/;

export function checkSerial(s: string): string {
  if (!SERIAL.test(s)) throw new Error(`invalid device serial ${JSON.stringify(s)}`);
  return s;
}
export function checkPackage(p: string): string {
  if (!PACKAGE.test(p) || p.length > 200) throw new Error(`invalid package name ${JSON.stringify(p)} (like com.example.app)`);
  return p;
}
export function checkAvd(n: string): string {
  if (!AVD.test(n)) throw new Error(`invalid AVD name ${JSON.stringify(n)}`);
  return n;
}
function coord(n: unknown, what: string): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0 || v > 20_000) throw new Error(`${what} must be a number of pixels (got ${JSON.stringify(n)})`);
  return String(Math.round(v));
}

/** Quote one word for the device's sh (adb shell joins args into a command line). */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export const KEYS: Record<string, number> = {
  home: 3,
  back: 4,
  call: 5,
  endcall: 6,
  up: 19,
  down: 20,
  left: 21,
  right: 22,
  center: 23,
  volume_up: 24,
  volume_down: 25,
  power: 26,
  camera: 27,
  tab: 61,
  space: 62,
  enter: 66,
  del: 67,
  backspace: 67,
  minus: 69,
  menu: 82,
  search: 84,
  play_pause: 85,
  page_up: 92,
  page_down: 93,
  escape: 111,
  forward_del: 112,
  delete: 112,
  move_home: 122,
  move_end: 123,
  app_switch: 187,
  recents: 187,
  wakeup: 224,
  sleep: 223,
};

/** A key name (back, home, enter…), KEYCODE_X, or a key code number → the code for `input keyevent`. */
export function keyCode(key: string | number): string {
  if (typeof key === "number" || /^\d{1,3}$/.test(String(key))) {
    const n = Number(key);
    if (!Number.isInteger(n) || n < 0 || n > 400) throw new Error(`key code ${key} is out of range`);
    return String(n);
  }
  const k = String(key).trim();
  if (/^KEYCODE_[A-Z0-9_]{1,40}$/.test(k)) return k;
  const named = KEYS[k.toLowerCase().replace(/[\s-]+/g, "_")];
  if (named !== undefined) return String(named);
  if (/^[a-z0-9]$/i.test(k)) return `KEYCODE_${k.toUpperCase()}`;
  throw new Error(`unknown key ${JSON.stringify(key)}; use ${Object.keys(KEYS).join(", ")}, KEYCODE_…, or a number`);
}

export const tapArgs = (x: unknown, y: unknown) => ["shell", "input", "tap", coord(x, "x"), coord(y, "y")];
export function swipeArgs(x1: unknown, y1: unknown, x2: unknown, y2: unknown, ms: unknown = 300): string[] {
  const d = Math.round(Number(ms ?? 300));
  if (!Number.isFinite(d) || d < 1 || d > 10_000) throw new Error("duration must be 1–10000 ms");
  return ["shell", "input", "swipe", coord(x1, "x1"), coord(y1, "y1"), coord(x2, "x2"), coord(y2, "y2"), String(d)];
}
export const keyArgs = (key: string | number) => ["shell", "input", "keyevent", keyCode(key)];
export const launchArgs = (pkg: string) => ["shell", "monkey", "-p", checkPackage(pkg), "-c", "android.intent.category.LAUNCHER", "1"];

/**
 * adb commands that type `text`: `input text` takes one word, turns %s into a
 * space and only knows ASCII; newline and tab become key events. A literal
 * "%s" is typed in two pieces, and a leading "-" as a key so it can't read as an option.
 */
export function textArgs(text: string): string[][] {
  if (text.length > 2000) throw new Error("text is longer than 2000 characters; type it in parts");
  if (/[^\x20-\x7e\n\t]/.test(text)) throw new Error("adb can only type plain ASCII text (no accents or emoji); paste other text on the device");
  const out: string[][] = [];
  for (const part of text.split(/(\n|\t)/)) {
    if (part === "\n") out.push(keyArgs("enter"));
    else if (part === "\t") out.push(keyArgs("tab"));
    else if (part) {
      for (let chunk of part.split(/(?<=%)(?=s)/)) {
        if (chunk.startsWith("-")) {
          out.push(keyArgs("minus"));
          chunk = chunk.slice(1);
        }
        if (chunk) out.push(["shell", "input", "text", shQuote(chunk.replace(/ /g, "%s"))]);
      }
    }
  }
  return out;
}

/** `adb devices -l` → devices. */
export function parseDevices(out: string): AndroidDevice[] {
  const rows: AndroidDevice[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\S+)\s+(device|offline|unauthorized|recovery|sideload|bootloader|no permissions|authorizing|connecting|host)\b(.*)$/.exec(line.trim());
    if (!m || line.startsWith("List of devices") || line.startsWith("*")) continue;
    const kv = Object.fromEntries([...m[3].matchAll(/(\w+):(\S+)/g)].map((x) => [x[1], x[2]]));
    rows.push({ serial: m[1], state: m[2], model: kv.model?.replace(/_/g, " "), product: kv.product, transport: kv.transport_id });
  }
  return rows;
}

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unxml = (s: string) => s.replace(/&(#x?[\da-f]+|\w+);/gi, (m, e: string) => (e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENT[e] ?? m)));
const clip = (s: string, n = 80) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
};

/**
 * uiautomator's XML dump → a compact indented tree of the nodes worth acting
 * on (text, description, id, clickable/scrollable/editable), each with its
 * centre point for hive_android_tap.
 */
export function uiXmlToText(xml: string, maxLines = 400): string {
  const lines: string[] = [];
  const stack: boolean[] = [];
  let depth = 0;
  let more = 0;
  for (const m of xml.matchAll(/<node\b([^>]*?)(\/?)>|<\/node\s*>/g)) {
    if (!m[0].startsWith("<node")) {
      if (stack.pop()) depth--;
      continue;
    }
    const a: Record<string, string> = {};
    for (const x of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) a[x[1]] = unxml(x[2]);
    const cls = (a.class ?? "").split(".").pop() || "node";
    const text = a.text ?? "";
    const desc = a["content-desc"] ?? "";
    const id = (a["resource-id"] ?? "").replace(/^.*:id\//, "");
    const on = (k: string) => a[k] === "true";
    const editable = /EditText/.test(cls);
    const flags = [
      on("clickable") || on("long-clickable") ? "clickable" : "",
      on("scrollable") ? "scrollable" : "",
      editable ? "editable" : "",
      on("checkable") ? (on("checked") ? "checked" : "unchecked") : "",
      on("selected") ? "selected" : "",
      on("focused") ? "focused" : "",
      on("password") ? "password" : "",
      a.enabled === "false" ? "disabled" : "",
    ].filter(Boolean);
    const b = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(a.bounds ?? "");
    const worth = !!(text.trim() || desc.trim() || id || flags.some((f) => f === "clickable" || f === "scrollable" || f === "editable" || f.endsWith("checked")));
    let printed = false;
    if (worth && b) {
      const [x1, y1, x2, y2] = b.slice(1).map(Number);
      if (lines.length < maxLines) {
        lines.push(
          `${"  ".repeat(depth)}${cls}${text.trim() ? ` "${clip(text)}"` : ""}${desc.trim() ? ` desc="${clip(desc)}"` : ""}${id ? ` #${id}` : ""} @${Math.round((x1 + x2) / 2)},${Math.round((y1 + y2) / 2)} [${x1},${y1} ${x2},${y2}]${flags.length ? " " + flags.join(" ") : ""}`,
        );
      } else more++;
      printed = true;
      depth++;
    }
    if (m[2] === "/") {
      if (printed) depth--;
    } else stack.push(printed);
  }
  if (more) lines.push(`… ${more} more nodes`);
  return lines.join("\n") || "(no visible elements)";
}

/** Width and height from a PNG header. */
export function pngSize(b: Buffer): { w: number; h: number } | undefined {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return undefined;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

// ---- running adb ----

export type AdbRunner = (args: string[], o?: { timeoutMs?: number }) => Promise<Buffer>;

function execAdb(bin: string): AdbRunner {
  return (args, o = {}) =>
    new Promise((res, rej) => {
      execFile(bin, args, { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: o.timeoutMs ?? 30_000, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          const msg = (Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? "")).trim() || err.message;
          return rej(new Error(`adb ${args.filter((a) => a !== "-s").slice(0, 3).join(" ")}: ${msg.slice(0, 400)}`));
        }
        res(stdout as Buffer);
      });
    });
}

export interface AndroidFrame {
  mime: string;
  data: string;
  w: number;
  h: number;
}

/**
 * adb for the pane and the agent tools. Emits "frame" while watched and
 * "state" when the device list or selection changes.
 */
export class AndroidHost extends EventEmitter {
  private bin?: string | null;
  private runner?: AdbRunner;
  selected?: string;
  private fps = 0;
  private timer?: NodeJS.Timeout;
  private capturing = false;
  private lastHash = "";
  private lastFrame?: AndroidFrame;
  private lastDevices: AndroidDevice[] = [];
  private lastProblem = "";

  constructor(private o: { adb?: string; runner?: AdbRunner } = {}) {
    super();
  }

  adbPath(refresh = false): string | null {
    if (this.o.adb) return this.o.adb;
    if (this.bin === undefined || refresh || this.bin === null) this.bin = findAdb() ?? null;
    return this.bin;
  }

  private run(args: string[], timeoutMs?: number): Promise<Buffer> {
    if (this.o.runner) return this.o.runner(args, { timeoutMs });
    const bin = this.adbPath();
    if (!bin) throw new Error(NO_ADB);
    this.runner ??= execAdb(bin);
    return this.runner(args, { timeoutMs });
  }

  /** Run `args` on a device (the selected one unless `serial` is given). */
  private async onDevice(serial: string | undefined, args: string[], timeoutMs?: number): Promise<Buffer> {
    const s = await this.pick(serial);
    return this.run(["-s", s, ...args], timeoutMs);
  }

  async devices(): Promise<AndroidDevice[]> {
    const out = await this.run(["devices", "-l"], 15_000);
    const list = parseDevices(out.toString("utf8"));
    const changed = JSON.stringify(list) !== JSON.stringify(this.lastDevices);
    this.lastDevices = list;
    if (this.selected && !list.some((d) => d.serial === this.selected && d.state === "device")) this.selected = undefined;
    if (changed) this.emit("state", await this.state(false));
    return list;
  }

  /** The device to use: `serial`, else the selected one, else the only/first online device. */
  async pick(serial?: string): Promise<string> {
    if (serial) return checkSerial(serial);
    if (this.selected) return this.selected;
    const list = await this.devices();
    const online = list.filter((d) => d.state === "device");
    if (!online.length) {
      const bad = list.find((d) => d.state === "unauthorized");
      throw new Error(
        bad
          ? `${bad.serial} is connected but unauthorized: unlock the phone and accept "Allow USB debugging"`
          : "no Android device connected: start an emulator, or plug in a phone with USB debugging on (see docs/DEVICES.md)",
      );
    }
    this.selected = online[0].serial;
    return this.selected;
  }

  async select(serial: string | undefined) {
    this.selected = serial ? checkSerial(serial) : undefined;
    this.lastHash = "";
    this.emit("state", await this.state(false));
  }

  async avds(): Promise<string[]> {
    const em = findEmulator();
    if (!em) return [];
    return new Promise((res) =>
      execFile(em, ["-list-avds"], { encoding: "utf8", timeout: 15_000, windowsHide: true }, (err, out) =>
        res(err ? [] : String(out).split(/\r?\n/).map((s) => s.trim()).filter((s) => AVD.test(s))),
      ),
    );
  }

  /** Start an emulator (it boots in its own window; adb sees it after a minute or so). */
  startAvd(name: string) {
    const em = findEmulator();
    if (!em) throw new Error("the Android emulator was not found (install it from Android Studio's SDK Manager)");
    const p = spawn(em, ["-avd", checkAvd(name)], { detached: true, stdio: "ignore", windowsHide: false });
    p.on("error", () => {});
    p.unref();
  }

  async state(refresh = true): Promise<AndroidState> {
    const adb = this.adbPath(refresh);
    const emulator = findEmulator() ?? null;
    if (!adb && !this.o.runner) return { adb: null, emulator, help: NO_ADB, devices: [], avds: await this.avds(), selected: undefined };
    let error: string | undefined;
    if (refresh) await this.devices().catch((e) => (error = String(e?.message ?? e)));
    return { adb, emulator, devices: this.lastDevices, avds: refresh ? await this.avds() : [], selected: this.selected ?? this.lastDevices.find((d) => d.state === "device")?.serial, error };
  }

  // ---- actions ----

  async screencap(serial?: string): Promise<Buffer> {
    const png = await this.onDevice(serial, ["exec-out", "screencap", "-p"], 20_000);
    if (!pngSize(png)) throw new Error("the device did not return a PNG screenshot (is the screen on and the device unlocked?)");
    return png;
  }
  async tap(x: unknown, y: unknown, serial?: string) {
    await this.onDevice(serial, tapArgs(x, y));
  }
  async swipe(x1: unknown, y1: unknown, x2: unknown, y2: unknown, ms?: unknown, serial?: string) {
    await this.onDevice(serial, swipeArgs(x1, y1, x2, y2, ms), 20_000);
  }
  async key(key: string | number, serial?: string) {
    await this.onDevice(serial, keyArgs(key));
  }
  async text(text: string, serial?: string) {
    const s = await this.pick(serial);
    for (const args of textArgs(text)) await this.run(["-s", s, ...args]);
  }
  async launch(pkg: string, serial?: string): Promise<string> {
    const out = (await this.onDevice(serial, launchArgs(pkg), 20_000)).toString("utf8");
    if (/No activities found|monkey aborted|Error/i.test(out)) throw new Error(`could not launch ${pkg}: ${out.trim().slice(0, 300)}`);
    return `launched ${pkg}`;
  }
  async install(apk: string, serial?: string): Promise<string> {
    const p = resolve(apk);
    if (!isAbsolute(p) || !/\.apks?$/i.test(p) || !isFile(p)) throw new Error(`${apk}: not an .apk file`);
    const out = (await this.onDevice(serial, ["install", "-r", p], 5 * 60_000)).toString("utf8");
    if (!/Success/.test(out)) throw new Error(`install failed: ${out.trim().slice(-400)}`);
    return `installed ${p}`;
  }
  async rotate(serial?: string): Promise<string> {
    const cur = Number((await this.onDevice(serial, ["shell", "settings", "get", "system", "user_rotation"])).toString("utf8").trim()) || 0;
    const next = (cur + 1) % 4;
    await this.onDevice(serial, ["shell", "settings", "put", "system", "accelerometer_rotation", "0"]);
    await this.onDevice(serial, ["shell", "settings", "put", "system", "user_rotation", String(next)]);
    return `rotation ${next * 90}°`;
  }
  async uiDump(serial?: string): Promise<string> {
    const path = "/sdcard/hive_ui.xml";
    await this.onDevice(serial, ["shell", "uiautomator", "dump", path], 30_000);
    const xml = (await this.onDevice(serial, ["exec-out", "cat", path])).toString("utf8");
    if (!xml.includes("<hierarchy")) throw new Error(`uiautomator returned no hierarchy: ${xml.slice(0, 200)}`);
    return uiXmlToText(xml);
  }

  // ---- streaming ----

  /** Poll the screen at up to `fps` (max 4; 0 stops). Unchanged frames aren't re-sent. */
  watch(fps: number) {
    this.fps = Math.max(0, Math.min(4, fps));
    clearInterval(this.timer);
    this.timer = undefined;
    if (!this.fps) return;
    if (this.lastFrame) this.emit("frame", this.lastFrame);
    this.timer = setInterval(() => void this.capture(), 1000 / this.fps);
    this.timer.unref?.();
    void this.capture();
  }

  private async capture() {
    if (this.capturing || !this.fps) return;
    this.capturing = true;
    try {
      const png = await this.screencap();
      const hash = createHash("sha1").update(png).digest("hex");
      if (hash === this.lastHash) return;
      this.lastHash = hash;
      const size = pngSize(png)!;
      this.lastFrame = { mime: "image/png", data: png.toString("base64"), w: size.w, h: size.h };
      this.emit("frame", this.lastFrame);
      this.lastProblem = "";
    } catch (e: any) {
      // "error" would throw without a listener; and only say it once, not every poll
      const msg = String(e?.message ?? e);
      if (msg !== this.lastProblem) this.emit("problem", msg);
      this.lastProblem = msg;
    } finally {
      this.capturing = false;
    }
  }

  dispose() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.fps = 0;
    this.removeAllListeners();
  }
}
