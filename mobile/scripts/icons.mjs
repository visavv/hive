// Writes the hive mark as the Android launcher icons and splash images (run once after `npx cap add android`;
// the results are committed). node scripts/icons.mjs
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { markPng } from "../../scripts/hex-icon.mjs";

const res = new URL("../android/app/src/main/res/", import.meta.url).pathname;
const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [d, k] of Object.entries(densities)) {
  const dir = join(res, `mipmap-${d}`);
  writeFileSync(join(dir, "ic_launcher.png"), markPng({ size: 48 * k, bg: "rounded", mark: 0.62 }));
  writeFileSync(join(dir, "ic_launcher_round.png"), markPng({ size: 48 * k, bg: "circle", mark: 0.58 }));
  // adaptive icon foreground: 108dp canvas, only the middle 66dp is sure to show
  writeFileSync(join(dir, "ic_launcher_foreground.png"), markPng({ size: 108 * k, bg: "none", mark: 0.42 }));
}
const splash = { mdpi: [320, 480], hdpi: [480, 800], xhdpi: [720, 1280], xxhdpi: [960, 1600], xxxhdpi: [1280, 1920] };
for (const [d, [w, h]] of Object.entries(splash)) {
  writeFileSync(join(res, `drawable-port-${d}`, "splash.png"), markPng({ size: w, w, h, bg: "square", mark: 0.28 }));
  writeFileSync(join(res, `drawable-land-${d}`, "splash.png"), markPng({ size: h, w: h, h: w, bg: "square", mark: 0.28 }));
}
writeFileSync(join(res, "drawable", "splash.png"), markPng({ size: 480, w: 480, h: 320, bg: "square", mark: 0.28 }));
console.log("icons written to", res);
