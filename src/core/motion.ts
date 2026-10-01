/**
 * Motion graphics: render a self-contained HTML animation to video.
 *
 * Contract (what an animation page must expose, see templates/motion/):
 *
 *   window.hiveRender = { duration, fps, width, height, seek(t) }
 *
 * seek(t) draws the frame at t seconds (it may return a promise). Rendering
 * never relies on requestAnimationFrame timing, so every render is the same.
 *
 * The page is served to headless Chromium (playwright-core) through request
 * interception from its own folder only: no network listener, no remote
 * content (other URLs are blocked, so CDN scripts fail; keep libraries next to
 * index.html). Frames are piped as PNGs to ffmpeg:
 *
 *   default   MP4, H.264, yuv420p (plays everywhere, YouTube-ready)
 *   alpha     MOV, ProRes 4444 with transparency (DaVinci Resolve, Premiere)
 *   frames    PNG sequence in a folder (no ffmpeg needed)
 *
 * Chromium: HIVE_CHROMIUM (path), else playwright's own browser if installed,
 * else Microsoft Edge or Google Chrome. ffmpeg: HIVE_FFMPEG, else ffmpeg on PATH.
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface MotionInfo {
  duration: number;
  fps: number;
  width: number;
  height: number;
}

export interface RenderOptions {
  /** Folder with index.html, or the .html file. */
  target: string;
  /** Output file (.mp4 / .mov) or, with `frames`, a folder. Default: next to the page. */
  out?: string;
  fps?: number;
  /** "1920x1080"; default: the page's width/height. */
  size?: string;
  alpha?: boolean;
  /** Write a PNG sequence instead of a video (no ffmpeg needed). */
  frames?: boolean;
  /** Only the first N seconds (previews, tests). */
  maxSeconds?: number;
  onProgress?: (frame: number, total: number) => void;
}

const HOST = "http://hive-motion.local/";
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

export function templatesDir(): string {
  // src/core or dist/core → <repo>/templates/motion
  return fileURLToPath(new URL("../../templates/motion/", import.meta.url));
}
export function motionTemplates(): string[] {
  const d = templatesDir();
  return existsSync(d) ? readdirSync(d).filter((f) => existsSync(join(d, f, "index.html"))) : [];
}

/** Copy a starter template to <cwd>/out/motion/<name>/. */
export function newMotion(cwd: string, name: string, template = "title-card"): string {
  if (!/^[\w.-]{1,60}$/.test(name)) throw new Error("name: letters, digits, _ . - only");
  const src = join(templatesDir(), template);
  if (!existsSync(join(src, "index.html"))) throw new Error(`no template "${template}" (templates: ${motionTemplates().join(", ")})`);
  const dest = join(resolve(cwd), "out", "motion", name);
  if (existsSync(dest)) throw new Error(`${dest} already exists`);
  cpSync(src, dest, { recursive: true });
  return dest;
}

export function findFfmpeg(): string | undefined {
  const cand = process.env.HIVE_FFMPEG || "ffmpeg";
  const r = spawnSync(cand, ["-hide_banner", "-version"], { encoding: "utf8", windowsHide: true });
  return r.status === 0 && /ffmpeg version/.test(r.stdout) ? cand : undefined;
}

export const FFMPEG_HELP =
  "ffmpeg is needed to make a video (or use --frames for a PNG sequence). Install it: Windows `winget install ffmpeg`, Fedora `sudo dnf install ffmpeg` (RPM Fusion), Ubuntu `sudo apt install ffmpeg`; or set HIVE_FFMPEG to its path.";

/** headless Chromium: HIVE_CHROMIUM, playwright's browser, then Edge / Chrome. */
export async function launchChromium() {
  const { chromium } = await import("playwright-core");
  const tries: Parameters<typeof chromium.launch>[0][] = [];
  if (process.env.HIVE_CHROMIUM) tries.push({ executablePath: process.env.HIVE_CHROMIUM });
  tries.push({}, { channel: "msedge" }, { channel: "chrome" });
  let last: unknown;
  for (const t of tries) {
    try {
      return await chromium.launch({ ...t, headless: true, args: ["--disable-gpu-vsync", "--force-color-profile=srgb"] });
    } catch (e) {
      last = e;
    }
  }
  throw new Error(
    `no Chromium to render with: install Microsoft Edge or Google Chrome, run \`npx playwright install chromium\`, or set HIVE_CHROMIUM to a Chromium/Chrome executable (${String((last as any)?.message ?? last).split("\n")[0]})`,
  );
}

function pageFile(target: string): { dir: string; file: string } {
  const t = resolve(target);
  if (!existsSync(t)) throw new Error(`${target} doesn't exist`);
  if (statSync(t).isDirectory()) {
    if (!existsSync(join(t, "index.html"))) throw new Error(`${target} has no index.html`);
    return { dir: t, file: "index.html" };
  }
  if (!/\.html?$/i.test(t)) throw new Error(`${target}: give a folder with index.html or an .html file`);
  return { dir: dirname(t), file: basename(t) };
}

function parseSize(s: string): { width: number; height: number } {
  const m = /^(\d{2,5})x(\d{2,5})$/i.exec(s.trim());
  if (!m) throw new Error(`--size is WIDTHxHEIGHT, e.g. 1920x1080 (got "${s}")`);
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (width % 2 || height % 2) throw new Error("--size: width and height must be even (H.264)");
  return { width, height };
}

export function ffmpegArgs(o: { fps: number; out: string; alpha?: boolean }): string[] {
  const input = ["-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", String(o.fps), "-c:v", "png", "-i", "-"];
  return o.alpha
    ? [...input, "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-vendor", "apl0", o.out]
    : [...input, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "medium", "-movflags", "+faststart", o.out];
}

/** Render the animation; returns the output path and what was rendered. */
export async function renderMotion(o: RenderOptions): Promise<{ out: string; frames: number; info: MotionInfo; ms: number }> {
  const t0 = Date.now();
  const { dir, file } = pageFile(o.target);
  const ffmpeg = o.frames ? undefined : findFfmpeg();
  if (!o.frames && !ffmpeg) throw new Error(FFMPEG_HELP);
  const out = resolve(o.out ?? join(dir, o.frames ? "frames" : `${basename(dir)}${o.alpha ? ".mov" : ".mp4"}`));
  if (!o.frames && o.alpha && extname(out).toLowerCase() !== ".mov") throw new Error("--alpha makes a ProRes 4444 .mov; give --out something.mov");
  const browser = await launchChromium();
  try {
    const size = o.size ? parseSize(o.size) : undefined;
    const ctx = await browser.newContext({ viewport: size ?? { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const root = dir.endsWith(sep) ? dir : dir + sep;
    // Serve the page's own folder; everything else (CDNs, trackers) is blocked.
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (url.startsWith("data:") || url.startsWith("blob:")) return route.continue();
      if (!url.startsWith(HOST)) return route.abort("blockedbyclient");
      const rel = decodeURIComponent(new URL(url).pathname).replace(/^\/+/, "");
      const p = resolve(dir, rel || file);
      if (!(p + sep).startsWith(root) && p !== dir) return route.fulfill({ status: 403, body: "outside the animation folder" });
      if (!existsSync(p) || !statSync(p).isFile()) return route.fulfill({ status: 404, body: "not found" });
      return route.fulfill({ status: 200, contentType: TYPES[extname(p).toLowerCase()] ?? "application/octet-stream", body: readFileSync(p) });
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // ?alpha=1 tells the page to leave out its background (templates honour it).
    await page.goto(HOST + encodeURIComponent(file) + (o.alpha ? "?alpha=1" : ""), { waitUntil: "load" });
    try {
      await page.waitForFunction(() => typeof (window as any).hiveRender?.seek === "function", undefined, { timeout: 15_000 });
    } catch {
      throw new Error(`the page doesn't expose window.hiveRender = { duration, fps, width, height, seek(t) }${errors.length ? ` (page error: ${errors[0]})` : ""}`);
    }
    const declared = (await page.evaluate(() => {
      const r = (window as any).hiveRender;
      return { duration: Number(r.duration), fps: Number(r.fps), width: Number(r.width), height: Number(r.height) };
    })) as MotionInfo;
    const info: MotionInfo = {
      duration: declared.duration,
      fps: o.fps ?? (declared.fps || 30),
      width: size?.width ?? (declared.width || 1920),
      height: size?.height ?? (declared.height || 1080),
    };
    if (!(info.duration > 0 && info.duration <= 600)) throw new Error(`hiveRender.duration must be 1–600 seconds (got ${declared.duration})`);
    if (!(info.fps >= 1 && info.fps <= 120)) throw new Error(`fps must be 1–120 (got ${info.fps})`);
    if (!size) await page.setViewportSize({ width: info.width, height: info.height });
    if (o.alpha) await page.addStyleTag({ content: "html,body{background:transparent!important}" });
    const total = Math.max(1, Math.round(Math.min(info.duration, o.maxSeconds ?? Infinity) * info.fps));

    let enc: ReturnType<typeof spawn> | undefined;
    let encErr = "";
    let encDone: Promise<number | null> | undefined;
    if (o.frames) mkdirSync(out, { recursive: true });
    else {
      mkdirSync(dirname(out), { recursive: true });
      enc = spawn(ffmpeg!, ffmpegArgs({ fps: info.fps, out, alpha: o.alpha }), { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
      enc.stderr!.on("data", (d) => (encErr += String(d)).length > 4000 && (encErr = encErr.slice(-4000)));
      encDone = new Promise((r) => enc!.on("close", r));
      enc.stdin!.on("error", () => {}); // reported through the exit code
    }
    for (let i = 0; i < total; i++) {
      const t = i / info.fps;
      await page.evaluate((tt) => (window as any).hiveRender.seek(tt), t);
      const png = await page.screenshot({ type: "png", omitBackground: !!o.alpha, clip: { x: 0, y: 0, width: info.width, height: info.height } });
      if (o.frames) writeFileSync(join(out, `frame-${String(i + 1).padStart(5, "0")}.png`), png);
      else if (!enc!.stdin!.write(png)) await new Promise((r) => enc!.stdin!.once("drain", r));
      o.onProgress?.(i + 1, total);
      if (errors.length) throw new Error(`the page threw while rendering frame ${i + 1}: ${errors[0]}`);
    }
    if (enc) {
      enc.stdin!.end();
      const code = await encDone!;
      if (code !== 0) throw new Error(`ffmpeg failed (${code}): ${encErr.trim().slice(-600)}`);
    }
    return { out, frames: total, info, ms: Date.now() - t0 };
  } finally {
    await browser.close().catch(() => {});
  }
}
