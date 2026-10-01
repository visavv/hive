/**
 * README screenshots: the real Electron app driven through a demo session
 * (mock agents in MOCK_DEMO mode play a planner / coder / reviewer / tester
 * squad on a small sample repo; no model is called). Not part of npm test.
 *
 *   node scripts/build-ui.mjs && xvfb-run -a npx tsx test/showcase.ts
 *
 * Writes docs/screenshots/*.png. Re-run after major UI changes.
 */
import { _electron as electron, type Page } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { freshDir, sleep } from "./util.js";
import { AGENTS } from "../src/core/agents.js";

const out = resolve("docs/screenshots");
mkdirSync(out, { recursive: true });
const repo = freshDir(".hive-test-showcase/acme-api");
process.env.HIVE_HOME = freshDir(".hive-test-showcase-home");

// sample project the agents "work" on
const git = (...a: string[]) => execFileSync("git", a, { cwd: repo });
mkdirSync(join(repo, "src/api"), { recursive: true });
writeFileSync(join(repo, "src/api/client.ts"), "export async function request(path: string) {\n  return fetch(path);\n}\n");
writeFileSync(join(repo, "README.md"), "# acme-api\n");
git("init", "-q", "-b", "main");
git("config", "user.email", "demo@example.com");
git("config", "user.name", "demo");
git("add", ".");
git("commit", "-qm", "init");

// demo agents: the mock in demo mode, under readable names
const demo = (label: string, model: string) => ({ type: "acp", label, command: AGENTS.mock.command, args: AGENTS.mock.args, env: { MOCK_DEMO: "1", MOCK_MODEL: model } });
writeFileSync(
  join(process.env.HIVE_HOME, "agents.json"),
  JSON.stringify({ "claude-code": demo("Claude Code (demo)", "Default (recommended)"), "codex-cli": demo("Codex (demo)", "gpt-5 · medium") }),
);

const require = createRequire(import.meta.url);
const app = await electron.launch({
  executablePath: require("electron") as unknown as string,
  args: [resolve("dist-ui/main.cjs"), "--cwd", repo, ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
  env: { ...process.env, HIVE_NODE: process.execPath, HIVE_HOTKEY: "CommandOrControl+Alt+F12" } as Record<string, string>,
});
const page: Page = await app.firstWindow();
page.on("pageerror", (e) => console.error("[renderer error]", e.message));
const W = 1680;
const H = 1000;
await page.setViewportSize({ width: W, height: H });
const shot = async (name: string) => {
  await sleep(400);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log("  ", name);
};
const pane = (n: string) => page.locator(`[data-pane="${n}"]`);
const send = async (n: string, text: string) => {
  await pane(n).locator("textarea").fill(text);
  await pane(n).locator("textarea").press("Enter");
};
const palette = async (q: string) => {
  await page.keyboard.press("Control+k");
  await page.locator(".palette .pal-input").fill(q);
  await page.keyboard.press("Enter");
  await sleep(300);
};

await page.locator(".welcome").waitFor({ timeout: 30_000 });
await shot("01-welcome");

// set up the squad from the recipe dialog
await page.locator(".welcome button", { hasText: "Set up a team" }).click();
await page.locator(".modal .recipe", { hasText: "Squad" }).click();
await page.locator(".modal label:has-text('Main agent') select").selectOption("claude-code");
await page.locator(".modal label:has-text('Checkers') select").selectOption("codex-cli");
await shot("02-recipes");
await page.locator(".modal button[type=submit]").click();
for (const n of ["planner", "coder", "reviewer", "tester"]) await pane(n).locator("textarea:not([disabled])").waitFor({ timeout: 30_000 });
await sleep(2500); // briefings

// work in flight: coder asks permission, tester is still running, planner and reviewer finished
await send("coder", "implement task 2 from the plan");
await sleep(1500);
await send("planner", "Plan: add rate limiting to the API client. Keep the public API unchanged.");
await send("reviewer", "review the new commits on hive/coder");
await send("tester", "test hive/coder: typecheck + full suite");
await sleep(4000);
await pane("coder").locator("textarea").focus();
await sleep(600);
await shot("03-squad");

await page.keyboard.press("Control+k");
await page.locator(".palette").waitFor();
await shot("04-palette");
await page.keyboard.press("Escape");

// one agent maximized: plan, diffs, permission prompt
await pane("coder").locator("textarea").focus();
await page.keyboard.press("Control+m");
await sleep(500);
await shot("05-focus-coder");
await page.keyboard.press("Control+m");

await pane("reviewer").locator("textarea").focus();
await page.keyboard.press("Control+m");
await sleep(500);
await shot("06-review");
await page.keyboard.press("Control+m");

// group chat for @squad
await pane("planner").locator(".group-chip").first().click();
await page.locator(".modal.wide").waitFor();
await shot("07-group-chat");
await page.keyboard.press("Escape");

// hive drawer: inbox, then usage
await page.keyboard.press("Control+i");
await page.locator(".drawer").waitFor();
await shot("08-hive-drawer");
await page.locator(".drawer .seg button", { hasText: /usage/i }).first().click().catch(() => {});
await shot("09-usage");
await page.keyboard.press("Escape");
if (await page.locator(".drawer").count()) await page.keyboard.press("Control+i");

// verdict setup
await palette("verdict");
await page.locator(".modal.wide").waitFor();
await shot("10-verdict");
await page.keyboard.press("Escape");

// light theme
await palette("theme");
await shot("11-light");
await palette("theme");

// 9:16 monitor
await page.setViewportSize({ width: 760, height: 1350 });
await sleep(800);
await shot("12-vertical");

await app.close();
process.exit(0);
