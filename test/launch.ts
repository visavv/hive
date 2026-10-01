/** Opening hive: bare `hive` picks the project, the app icon is valid pixel art. */
import { mkdirSync, readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { assert, finish, freshDir } from "./util.js";
import { pickProject, rememberProject, lastProject } from "../src/core/home.js";

const dir = freshDir(".hive-test-launch");
process.env.HIVE_HOME = join(dir, "home");
const proj = join(dir, "myproject");
mkdirSync(proj, { recursive: true });
const repo = resolve(".");

assert(pickProject(proj, { hiveRoot: repo }) === resolve(proj), "a project folder opens itself");
assert(pickProject(homedir(), { hiveRoot: repo, last: proj }) === proj, "from your home folder: the last project");
assert(pickProject(repo, { hiveRoot: repo, last: proj }) === proj, "from hive's own folder: the last project");
assert(pickProject(resolve("/"), { hiveRoot: repo }) === undefined, "from a drive root with no last project: ask (folder picker)");
assert(lastProject() === undefined, "no last project at first");
rememberProject(proj);
assert(lastProject() === resolve(proj), "the opened project is remembered");

// bare `hive` (dry run): opens the app on the folder, without --pick
const cli = ["node_modules/tsx/dist/cli.mjs", "src/cli/index.ts"];
const out = join(dir, "launch.txt");
execFileSync(process.execPath, cli.map((p) => join(repo, p)), { cwd: proj, env: { ...process.env, HIVE_LAUNCH_DRY: out } });
const cmd = readFileSync(out, "utf8");
assert(cmd.includes("main.cjs") && cmd.includes(`--cwd\n${resolve(proj)}`) && !cmd.includes("--pick"), "bare `hive` opens the app on this folder");
execFileSync(process.execPath, cli.map((p) => join(repo, p)), { cwd: homedir(), env: { ...process.env, HIVE_LAUNCH_DRY: out } });
assert(readFileSync(out, "utf8").includes(`--cwd\n${resolve(proj)}`), "from home it reopens the last project");
process.env.HIVE_HOME = join(dir, "home2");
execFileSync(process.execPath, cli.map((p) => join(repo, p)), { cwd: homedir(), env: { ...process.env, HIVE_LAUNCH_DRY: out } });
assert(readFileSync(out, "utf8").includes("--pick"), "first run from home: a folder picker");
const help = execFileSync(process.execPath, [...cli.map((p) => join(repo, p)), "help"], { encoding: "utf8" });
assert(/hive ui/.test(help), "`hive help` still prints the usage");

// icon files (scripts/pixel-icon.mjs)
const { iconPng, iconIco, sprite } = await import("../scripts/pixel-icon.mjs");
assert(sprite().length === 32 && sprite().every((r: string) => r.length === 32), "the sprite is 32×32");
const png = readFileSync(join(repo, "assets", "hive.png"));
assert(png.subarray(1, 4).toString() === "PNG" && png.readUInt32BE(16) === 256, "assets/hive.png is a 256 px PNG");
// compare decoded pixels, not bytes: zlib builds compress differently (Fedora vs Ubuntu vs Windows)
const pixels = (b: Buffer) => {
  const parts: Buffer[] = [];
  for (let o = 8; o < b.length; ) {
    const len = b.readUInt32BE(o);
    if (b.toString("ascii", o + 4, o + 8) === "IDAT") parts.push(b.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  return inflateSync(Buffer.concat(parts));
};
assert(Buffer.compare(pixels(png), pixels(iconPng(256))) === 0, "assets/hive.png matches the generator (run node scripts/pixel-icon.mjs after editing it)");
const ico = readFileSync(join(repo, "assets", "hive.ico"));
const sizes = [16, 24, 32, 48, 64, 128, 256];
const entries = sizes.map((_, i) => ico.subarray(ico.readUInt32LE(6 + i * 16 + 12), ico.readUInt32LE(6 + i * 16 + 12) + ico.readUInt32LE(6 + i * 16 + 8)));
assert(
  ico.readUInt16LE(2) === 1 && ico.readUInt16LE(4) === 7 && entries.every((e, i) => e.readUInt32BE(16) === sizes[i] && Buffer.compare(pixels(e), pixels(iconPng(sizes[i]))) === 0) && iconIco().readUInt16LE(4) === 7,
  "assets/hive.ico holds 7 sizes and matches the generator",
);
finish("launch");
