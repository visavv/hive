/**
 * Pane UI end to end: real Electron window, real backend, mock agents.
 * Needs a display (on Linux CI run under xvfb-run). `npm run test:ui`.
 */
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assert, finish, freshDir, sleep } from "./util.js";
import { projectDir } from "../src/core/home.js";

const dir = freshDir(".hive-test-ui");
process.env.HIVE_HOME = freshDir(".hive-test-ui-home"); // fresh default db + ui.json per run
const shots = resolve(process.env.SHOT_DIR ?? dir);
const electronBin = resolve("node_modules/electron/dist/electron" + (process.platform === "win32" ? ".exe" : ""));

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    executablePath: electronBin,
    args: [resolve("dist-ui/main.cjs"), "--cwd", dir, ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    env: { ...process.env, HIVE_NODE: process.execPath, HIVE_HOTKEY: "CommandOrControl+Alt+F12" } as Record<string, string>,
  });
  const page = await app.firstWindow();
  page.on("pageerror", (e) => console.error("[renderer error]", e.message));
  page.on("console", (m) => m.type() === "error" && console.error("[renderer console]", m.text()));
  await page.setViewportSize({ width: 1600, height: 950 }).catch(() => {});
  return { app, page };
}

async function addAgent(page: Page, name: string, policy = "ask", extra?: { cwd?: string; preset?: string }) {
  await page.keyboard.press("Control+N");
  const dlg = page.locator(".modal");
  await dlg.waitFor();
  await dlg.locator("select").first().selectOption("mock");
  await dlg.locator("label:has-text('Name') input").fill(name);
  if (extra?.cwd) await dlg.locator("label:has-text('Folder') input").fill(extra.cwd);
  if (extra?.preset) await dlg.locator("label:has-text('Preset') select").selectOption(extra.preset);
  else await dlg.locator("label:has-text('Permissions') select").selectOption(policy);
  await dlg.locator("button[type=submit]").click();
  await page.locator(`[data-pane="${name}"] textarea:not([disabled])`).waitFor({ timeout: 20_000 });
}

const pane = (page: Page, name: string) => page.locator(`[data-pane="${name}"]`);
const activeIn = (page: Page, name: string) =>
  page.evaluate((n) => !!document.activeElement?.closest(`[data-pane="${n}"]`), name);

let { app, page } = await launch();
try {
  await page.locator(".welcome").waitFor({ timeout: 20_000 });
  assert(true, "app boots to the welcome screen");

  await addAgent(page, "alpha");
  await addAgent(page, "beta", "allow-all");
  assert((await page.locator(".pane").count()) === 2, "two panes open");
  assert((await page.locator(".agent-item").count()) === 2, "sidebar lists both agents");

  // prompt + permission prompt answered in the pane
  await pane(page, "alpha").locator("textarea").fill("please edit something");
  await pane(page, "alpha").locator("textarea").press("Enter");
  const perm = pane(page, "alpha").locator(".ask.perm");
  await perm.waitFor({ timeout: 10_000 });
  assert(await page.locator(".pane.needs-you").count(), "pane is highlighted while waiting on a permission");
  await perm.locator("button", { hasText: "Allow" }).click();
  await pane(page, "alpha").locator(".msg.agent", { hasText: "edit allowed" }).waitFor({ timeout: 10_000 });
  assert(true, "permission answered from the pane; agent continued");
  const cards = await pane(page, "alpha").locator(".tool").allInnerTexts();
  assert(cards.length > 0 && cards.every((c) => c.includes("✓")), "tool calls render as one card each, updated in place");
  await pane(page, "alpha").locator(".ctx").waitFor({ timeout: 5000 });
  assert(/\d+%/.test(await pane(page, "alpha").locator(".ctx").innerText()), "ctx % meter shown in pane header");
  assert(await pane(page, "alpha").locator(".cfg select").count(), "model selector from configOptions shown");

  // phase 4: hover focus, Ctrl+N jump, Ctrl+Tab
  await pane(page, "beta").locator(".transcript").hover();
  await sleep(100);
  assert(await activeIn(page, "beta"), "hovering a pane focuses its input");
  await page.keyboard.press("Control+1");
  assert(await activeIn(page, "alpha"), "Ctrl+1 focuses the first pane");
  await page.keyboard.press("Control+Tab");
  assert(await activeIn(page, "beta"), "Ctrl+Tab cycles to the next pane");

  // ↑ recalls last prompt
  await page.keyboard.press("Control+1");
  await pane(page, "alpha").locator("textarea").press("ArrowUp");
  assert((await pane(page, "alpha").locator("textarea").inputValue()) === "please edit something", "↑ recalls the last prompt");
  await pane(page, "alpha").locator("textarea").fill("");

  // broadcast to all
  await page.locator(".broadcast input").fill("agents? roll call");
  await page.locator(".broadcast input").press("Enter");
  await pane(page, "alpha").locator(".msg.user", { hasText: "roll call" }).waitFor({ timeout: 10_000 });
  await pane(page, "beta").locator(".msg.user", { hasText: "roll call" }).waitFor({ timeout: 10_000 });
  assert(true, "broadcast reaches every pane");

  // hostile markdown: images from agent output never load
  await pane(page, "beta").locator("textarea").fill("hostile-img");
  await pane(page, "beta").locator("textarea").press("Enter");
  await pane(page, "beta").locator(".img-blocked").first().waitFor({ timeout: 10_000 });
  assert((await page.locator(".transcript img").count()) === 0, "images in agent markdown are not rendered (no file:/SMB loads)");

  // reload with a pending permission: panes and the ask survive, answering still works
  await pane(page, "alpha").locator("textarea").fill("please edit again");
  await pane(page, "alpha").locator("textarea").press("Enter");
  await pane(page, "alpha").locator(".ask.perm:not(.done)").waitFor({ timeout: 10_000 });
  await page.reload();
  await pane(page, "alpha").locator(".ask.perm:not(.done)").waitFor({ timeout: 15_000 });
  assert((await page.locator(".pane").count()) === 2, "renderer reload keeps every pane");
  await pane(page, "alpha").locator(".ask.perm:not(.done) button", { hasText: "Allow" }).click();
  await pane(page, "alpha").locator(".msg.agent", { hasText: "edit allowed" }).nth(1).waitFor({ timeout: 10_000 });
  assert(true, "pending permission re-shown after reload and answerable");

  // backend crash: it restarts and panes come back
  const backendPid = Number(execFileSync("pgrep", ["-f", "--newest", "src/ui/backend.ts --cwd"], { encoding: "utf8" }).trim().split("\n")[0]);
  process.kill(backendPid, "SIGKILL");
  await page.locator(".toast", { hasText: "restarting" }).waitFor({ timeout: 10_000 });
  await sleep(1500);
  await page.locator(`[data-pane="alpha"] textarea:not([disabled])`).waitFor({ timeout: 30_000 });
  await page.locator(`[data-pane="beta"] textarea:not([disabled])`).waitFor({ timeout: 30_000 });
  assert(true, "backend crash: auto-restart, panes reconnect");

  // columns + maximize
  await page.locator(".cols button", { hasText: "−" }).click();
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".grid")!).gridTemplateColumns.split(" ").length === 1);
  assert(true, "columns control changes the grid");
  await page.keyboard.press("Control+1");
  await page.keyboard.press("Control+M");
  await page.waitForFunction(() => document.querySelectorAll(".pane").length === 1);
  assert(true, "Ctrl+M maximizes the focused pane");
  await page.keyboard.press("Control+2");
  await page.waitForFunction(() => document.querySelectorAll(".pane").length === 2);
  await sleep(100);
  assert(await activeIn(page, "beta"), "Ctrl+2 while maximized restores the grid and focuses pane 2");
  await page.locator(".cols button", { hasText: "+" }).click();

  // schedule a job from the pane
  await pane(page, "beta").locator("button[title^='schedule']").click();
  await page.locator(".modal textarea").fill("hunt bugs");
  await page.locator(".modal label:has-text('Times') input").fill("2");
  await page.locator(".modal button[type=submit]").click();
  await page.locator(".job-list li.ended", { hasText: "done" }).waitFor({ timeout: 20_000 });
  assert(true, "job scheduled from a pane runs and shows as done in the sidebar");

  await page.screenshot({ path: join(shots, "hive-ui.png") });
  const layout = JSON.parse(readFileSync(join(projectDir(dir), "ui.json"), "utf8"));
  assert(layout.panes.length === 2 && layout.columns === 2, "layout persisted to .hive/ui.json");

  // coder preset in a git repo → own worktree; merge it from the sidebar
  const repo = mkdtempSync(join(tmpdir(), "hive-ui-repo-"));
  const g = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  writeFileSync(join(repo, "a.txt"), "a\n");
  g(["add", "."]);
  g(["commit", "-qm", "init"]);
  await addAgent(page, "gamma", "ask", { cwd: repo, preset: "coder" });
  await pane(page, "gamma").locator(".branch", { hasText: "hive/gamma" }).waitFor({ timeout: 10_000 });
  assert(true, "coder preset puts the agent in its own worktree (branch shown in pane)");
  const wt = g(["worktree", "list", "--porcelain"]).split("\n\n").find((b) => b.includes("refs/heads/hive/gamma"))!.match(/^worktree (.+)$/m)![1];
  writeFileSync(join(wt, "feature.txt"), "x\ny\n");
  g(["add", "."], wt);
  g(["commit", "-qm", "agent feature"], wt);
  await page.locator(".wt-list button[title='refresh'], .side-head button[title='refresh']").first().click();
  const wtItem = page.locator(".wt-list li", { hasText: "gamma" });
  await wtItem.locator("text=↑1").waitFor({ timeout: 10_000 });
  page.once("dialog", (d) => void d.accept());
  await wtItem.locator("button", { hasText: "merge" }).click();
  await page.locator(".toast", { hasText: "merged hive/gamma into main" }).waitFor({ timeout: 10_000 });
  assert(existsSync(join(repo, "feature.txt")), "merge button merged the agent branch into main");
  await page.screenshot({ path: join(shots, "hive-ui-worktree.png") });
  await pane(page, "gamma").locator("button.close").click();
} catch (e) {
  await page.screenshot({ path: join(shots, "hive-ui-failure.png") }).catch(() => {});
  throw e;
} finally {
  await app.close();
}

// restart: panes come back, sessions resume, history is shown
({ app, page } = await launch());
try {
  await page.locator(`[data-pane="alpha"] textarea:not([disabled])`).waitFor({ timeout: 20_000 });
  await page.locator(`[data-pane="beta"] textarea:not([disabled])`).waitFor({ timeout: 20_000 });
  assert(true, "panes restored after restart");
  await pane(page, "alpha").locator(".msg.user", { hasText: "please edit something" }).waitFor({ timeout: 10_000 });
  assert(true, "transcript history restored from the hive db");
  assert(await pane(page, "alpha").locator(".notice", { hasText: "session resumed" }).count(), "ACP session resumed, not recreated");
  await page.screenshot({ path: join(shots, "hive-ui-restored.png") });
} finally {
  await app.close();
}
assert(existsSync(join(shots, "hive-ui.png")), `screenshots in ${shots}`);
finish("ui");
