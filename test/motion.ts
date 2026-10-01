/**
 * Motion rendering: HTML animation (window.hiveRender contract) → frames → ffmpeg.
 * Needs a Chromium (playwright's, Edge or Chrome; HIVE_CHROMIUM) — skipped without one.
 * The video part needs ffmpeg — skipped without it (frames are still tested).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { assert, finish, freshDir } from "./util.js";
import { findFfmpeg, launchChromium, motionTemplates, newMotion, renderMotion } from "../src/core/motion.js";

if (!process.env.HIVE_CHROMIUM && existsSync("/opt/pw-browsers/chromium")) process.env.HIVE_CHROMIUM = "/opt/pw-browsers/chromium";
try {
  await (await launchChromium()).close();
} catch (e: any) {
  console.log(`⏭  motion: skipped, no Chromium to render with (${String(e?.message ?? e).slice(0, 160)})`);
  finish("motion");
}

const dir = freshDir(".hive-test-motion");
const anim = join(dir, "anim");
mkdirSync(anim);
writeFileSync(join(dir, "secret.txt"), "top secret");
writeFileSync(
  join(anim, "index.html"),
  `<!doctype html><html><body style="margin:0"><canvas id="c" width="64" height="48"></canvas>
<script src="lib.js"></script>
<script>
  const cx = document.getElementById("c").getContext("2d");
  window.hiveRender = { duration: 0.5, fps: 10, width: 64, height: 48, seek(t) {
    cx.clearRect(0, 0, 64, 48);
    if (!new URLSearchParams(location.search).has("alpha")) { cx.fillStyle = "#000"; cx.fillRect(0, 0, 64, 48); }
    cx.fillStyle = COLOR; cx.fillRect(Math.round(t * 100), 10, 10, 10);
    document.title = String(t);
  } };
</script></body></html>`,
);
writeFileSync(join(anim, "lib.js"), `window.COLOR = "#ff0000";`);

// frames: count, determinism, local files served, remote and outside files blocked
const r1 = await renderMotion({ target: anim, frames: true, out: join(dir, "f1") });
const f1 = readdirSync(join(dir, "f1")).sort();
assert(r1.frames === 5 && f1.length === 5 && f1[0] === "frame-00001.png", `duration × fps frames (${f1.length})`);
assert(r1.info.width === 64 && r1.info.height === 48 && r1.info.fps === 10, "size and fps from the page's hiveRender");
const r2 = await renderMotion({ target: join(anim, "index.html"), frames: true, out: join(dir, "f2") });
assert(f1.every((f) => readFileSync(join(dir, "f1", f)).equals(readFileSync(join(dir, "f2", f)))), "rendering is deterministic (same frames twice)");
assert(!readFileSync(join(dir, "f1", f1[0])).equals(readFileSync(join(dir, "f1", f1[4]))), "seek(t) moves the animation between frames");
assert(r2.frames === 5, "an .html file works as the target too");

const probeOut = await renderMotion({ target: anim, frames: true, out: join(dir, "f3"), fps: 2, maxSeconds: 0.5 });
assert(probeOut.frames === 1 && probeOut.info.fps === 2, "--fps and a seconds limit apply");

// What a page can reach: its own folder only (it throws from seek() if anything leaked).
writeFileSync(
  join(anim, "probe.html"),
  `<!doctype html><script>
  // hiveRender appears only once both requests settled, so the render waits for them.
  Promise.all([
    fetch("https://example.com/x.js").then(() => "loaded", () => "blocked"),
    fetch("../secret.txt").then((r) => (r.ok ? r.text() : "status " + r.status), () => "error"),
  ]).then(([remote, secret]) => {
    window.hiveRender = { duration: 0.1, fps: 10, width: 20, height: 20, seek() { if (remote !== "blocked" || secret.includes("top secret")) throw new Error("LEAK " + remote + " " + secret); } };
  });
</script>`,
);
let leak = "";
await renderMotion({ target: join(anim, "probe.html"), frames: true, out: join(dir, "f4") }).catch((e) => (leak = e.message));
assert(!/LEAK/.test(leak), `remote URLs and files outside the folder are blocked (${leak || "ok"})`);

// contract errors
writeFileSync(join(anim, "bad.html"), "<!doctype html><p>no contract</p>");
let err = "";
await renderMotion({ target: join(anim, "bad.html"), frames: true, out: join(dir, "f5") }).catch((e) => (err = e.message));
assert(/window\.hiveRender/.test(err), "a page without the contract gets a clear error");

// templates
assert(motionTemplates().includes("title-card"), "starter template: title-card");
const d = newMotion(dir, "intro");
const t = await renderMotion({ target: d, frames: true, out: join(dir, "tpl"), maxSeconds: 0.1, size: "640x360" });
assert(t.frames === 3 && t.info.width === 640, "the title-card template renders (with --size)");

// video
const ff = findFfmpeg();
if (!ff) console.log("⏭  motion: ffmpeg not found, MP4/MOV encoding not tested (frames were)");
else {
  const mp4 = await renderMotion({ target: anim, out: join(dir, "out.mp4") });
  const head = readFileSync(mp4.out).subarray(0, 64).toString("latin1");
  assert(head.includes("ftyp"), "MP4 (H.264) written by ffmpeg");
  const mov = await renderMotion({ target: anim, alpha: true, out: join(dir, "out.mov") });
  assert(readFileSync(mov.out).includes(Buffer.from("ap4h")), "--alpha: ProRes 4444 MOV");
  let e2 = "";
  await renderMotion({ target: anim, alpha: true, out: join(dir, "x.mp4") }).catch((e) => (e2 = e.message));
  assert(/\.mov/.test(e2), "--alpha insists on .mov");
}

finish("motion");
