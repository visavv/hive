/**
 * Pane UI end to end: real Electron window, real backend, mock agents.
 * Needs a display (on Linux CI run under xvfb-run). `npm run test:ui`.
 */
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { assert, finish, freshDir, sleep } from "./util.js";
import { projectDir } from "../src/core/home.js";
import { AGENTS } from "../src/core/agents.js";
import { findChromium } from "../src/hive/browser.js";
import { createServer } from "node:http";

const dir = freshDir(".hive-test-ui");
process.env.HIVE_HOME = freshDir(".hive-test-ui-home"); // fresh default db + ui.json per run
// A second agent type (the mock again) so verdict mode has two contenders.
writeFileSync(join(process.env.HIVE_HOME, "agents.json"), JSON.stringify({ mock2: { type: "acp", label: "Mock agent 2", command: AGENTS.mock.command, args: AGENTS.mock.args } }));
const shots = resolve(process.env.SHOT_DIR ?? dir);
const require = createRequire(import.meta.url);
let electronBin = require("electron") as unknown as string;
if (!existsSync(electronBin)) {
  // npm sometimes skips electron's postinstall download
  execFileSync(process.execPath, [require.resolve("electron/install.js")], { stdio: "inherit" });
  electronBin = require("electron") as unknown as string;
}

// Voice: a fake local Whisper server (OpenAI-compatible) for dictation.
const sttSeen: { type: string; bytes: number }[] = [];
const stt = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const form = await new Request("http://x/", { method: "POST", headers: { "content-type": String(req.headers["content-type"]) }, body: Buffer.concat(chunks) }).formData();
  const f = form.get("file") as File | null;
  sttSeen.push({ type: f?.type ?? "", bytes: f?.size ?? 0 });
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ text: "hello from the fake whisper" }));
});
await new Promise<void>((r) => stt.listen(0, "127.0.0.1", r));
stt.unref();
const sttUrl = `http://127.0.0.1:${(stt.address() as any).port}`;

/** PID of the UI backend (node running src/ui/backend.ts). */
function findBackendPid(): number | undefined {
  try {
    if (process.platform === "win32") {
      const out = execFileSync(
        "powershell",
        ["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*src*ui*backend.ts*--cwd*' -and $_.CommandLine -like '*loader*' } | Sort-Object CreationDate -Descending | Select-Object -First 1 -ExpandProperty ProcessId"],
        { encoding: "utf8" },
      ).trim();
      return out ? Number(out) : undefined;
    }
    const out = execFileSync("pgrep", ["-f", "--newest", "src/ui/backend.ts --cwd"], { encoding: "utf8" }).trim();
    return out ? Number(out.split("\n")[0]) : undefined;
  } catch {
    return undefined;
  }
}

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    executablePath: electronBin,
    // Chromium's fake microphone (a beep) and no permission prompt: dictation can be tested end to end.
    args: [resolve("dist-ui/main.cjs"), "--cwd", dir, "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    env: { ...process.env, HIVE_NODE: process.execPath, HIVE_HOTKEY: "CommandOrControl+Alt+F12", HIVE_SHOW_MOCK: "1", HIVE_STT: "local", HIVE_STT_URL: sttUrl, ELEVENLABS_API_KEY: "" } as Record<string, string>,
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

/** Poll an async condition (page.waitForFunction with a string is blocked by the app's CSP). */
async function until(cond: () => Promise<boolean>, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(150);
  }
  throw new Error("timed out waiting");
}
const pane = (page: Page, name: string) => page.locator(`[data-pane="${name}"]`);
/** Run a command through the Ctrl+K palette. */
async function command(page: Page, text: string) {
  await page.keyboard.press("Control+k");
  await page.locator(".palette .pal-input").fill(text);
  await page.locator(".palette .pal-item.on").waitFor({ timeout: 5000 });
  await page.keyboard.press("Enter");
  await page.locator(".palette").waitFor({ state: "detached", timeout: 5000 });
}
const activeIn = (page: Page, name: string) =>
  page.evaluate((n) => !!document.activeElement?.closest(`[data-pane="${n}"]`), name);

/** Rows whose visible children are not centered on the row (more than 1px off). */
async function alignment(page: Page): Promise<{ row: string; el: string; dy: number }[]> {
  return page.evaluate(`(() => {
    const rows = [".topbar", ".pane-head", ".group-chip", ".agent-item .row1", ".side-head", ".side-search", ".pane-sub", ".welcome-actions", ".pane-actions", ".cols", ".broadcast"];
    const out = [];
    const name = (e) => e.tagName.toLowerCase() + (e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\\s+/).join(".") : "");
    for (const sel of rows)
      for (const row of document.querySelectorAll(sel)) {
        const r = row.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const cs = getComputedStyle(row);
        const top = r.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop);
        const bottom = r.bottom - parseFloat(cs.borderBottomWidth) - parseFloat(cs.paddingBottom);
        const mid = (top + bottom) / 2;
        for (const el of row.children) {
          const b = el.getBoundingClientRect();
          if (!b.width || !b.height || getComputedStyle(el).position === "absolute") continue;
          if (el.classList.contains("spacer")) continue;
          const dy = Math.round(((b.top + b.bottom) / 2 - mid) * 10) / 10;
          if (Math.abs(dy) > 1) out.push({ row: sel, el: name(el), dy, h: Math.round(b.height), rowH: Math.round(bottom - top) });
        }
      }
    return out;
  })()`);
}

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
  // hive's own bookkeeping (checking mail) is one quiet line per call, updated in place — not a card
  const lines = await pane(page, "alpha").locator(".tool-line").allInnerTexts();
  assert(lines.length > 0 && lines.every((c) => c.includes("checked mail")) && (await pane(page, "alpha").locator(".tool").count()) === 0, "hive's own tool calls show as quiet one-liners, updated in place");
  await pane(page, "alpha").locator(".ctx").waitFor({ timeout: 5000 });
  assert(/\d+%/.test(await pane(page, "alpha").locator(".ctx").innerText()), "ctx % meter shown in pane header");
  assert(await pane(page, "alpha").locator(".cfg select").count(), "model selector from configOptions shown");

  // phase 4: hover focus, Ctrl+N jump, Ctrl+Tab
  await pane(page, "beta").locator(".transcript").hover();
  await sleep(700);
  assert(await activeIn(page, "beta"), "hovering a pane focuses its input (after a short dwell)");
  await pane(page, "beta").locator("textarea").fill("draft in progress");
  await pane(page, "alpha").locator(".transcript").hover();
  await sleep(700);
  assert(await activeIn(page, "beta"), "hover doesn't steal focus from an input with an unsent draft");
  await pane(page, "beta").locator("textarea").fill("");
  await page.keyboard.press("Control+1");
  assert(await activeIn(page, "alpha"), "Ctrl+1 focuses the first pane");
  await page.locator(".agent-item.current", { hasText: "alpha" }).waitFor({ timeout: 2000 });
  await page.keyboard.press("Control+Tab");
  assert(await activeIn(page, "beta"), "Ctrl+Tab cycles to the next pane");
  await page.locator(".agent-item.current", { hasText: "beta" }).waitFor({ timeout: 2000 });
  assert(true, "the sidebar's current-agent highlight follows focus");

  // stacked overlays: pane shortcuts and the palette don't act behind a dialog; Esc closes only the top one
  await page.keyboard.press("Control+N");
  await page.locator(".modal").waitFor();
  await page.keyboard.press("Control+1");
  await page.keyboard.press("Control+k");
  await sleep(200);
  assert(
    (await page.locator(".palette").count()) === 0 && (await page.evaluate(() => !!document.activeElement?.closest(".modal"))),
    "inside a dialog, Ctrl+1 and Ctrl+K don't reach the panes or open the palette",
  );
  await page.keyboard.press("Escape");
  await page.locator(".modal").waitFor({ state: "detached", timeout: 2000 });
  await page.keyboard.press("Control+k");
  await page.locator(".palette").waitFor();
  await page.keyboard.press("Escape");
  await page.locator(".palette").waitFor({ state: "detached", timeout: 2000 });
  assert((await page.locator(".pane").count()) === 2, "Esc closes the palette only");

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

  // voice: mic button -> fake microphone -> fake Whisper server -> text at the cursor (not sent)
  const ta = pane(page, "alpha").locator("textarea");
  await ta.fill("note: ");
  await ta.press("End");
  await pane(page, "alpha").locator(".mic-btn").click();
  await pane(page, "alpha").locator(".mic.recording .mic-live").waitFor({ timeout: 10_000 });
  assert(/\d:\d\d/.test(await pane(page, "alpha").locator(".mic-time").innerText()), "recording shows a level meter and elapsed time");
  await sleep(1200);
  await pane(page, "alpha").locator(".mic-btn").click();
  await page.waitForFunction(() => (document.querySelector('[data-pane="alpha"] textarea') as HTMLTextAreaElement).value.includes("fake whisper"), null, { timeout: 15_000 });
  assert((await ta.inputValue()) === "note: hello from the fake whisper", `dictated text inserted at the cursor (${await ta.inputValue()})`);
  assert(sttSeen.length === 1 && sttSeen[0].type.startsWith("audio/") && sttSeen[0].bytes > 500, `the recording went to the STT server (${JSON.stringify(sttSeen)})`);
  assert((await pane(page, "alpha").locator(".msg.user", { hasText: "fake whisper" }).count()) === 0, "dictation doesn't send unless 'send after dictation' is on");
  // push-to-talk: hold Ctrl+Shift+Space
  await ta.fill("");
  await ta.focus();
  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  await page.keyboard.down("Space");
  await pane(page, "alpha").locator(".mic.recording").waitFor({ timeout: 10_000 });
  await sleep(1000);
  await page.keyboard.up("Space");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
  await page.waitForFunction(() => (document.querySelector('[data-pane="alpha"] textarea') as HTMLTextAreaElement).value === "hello from the fake whisper", null, { timeout: 15_000 });
  assert(sttSeen.length === 2, "holding Ctrl+Shift+Space records and types into the focused pane");
  await ta.fill("");
  // voice menu + palette entries
  await pane(page, "alpha").locator('.voice-ctl button[aria-label="voice settings"]').click();
  await page.locator(".voice-menu", { hasText: "Spoken replies need ELEVENLABS_API_KEY" }).waitFor({ timeout: 5000 });
  await page.keyboard.press("Escape");
  await page.locator(".voice-menu").waitFor({ state: "detached", timeout: 2000 });
  assert(true, "pane voice menu opens and explains the missing ElevenLabs key; Esc closes it");
  await command(page, "Send after dictation");
  assert(JSON.parse(readFileSync(join(projectDir(dir), "ui.json"), "utf8")).voice?.sendAfter === true, "palette: send after dictation saved in the layout");
  await command(page, "Send after dictation");

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
  const backendPid = findBackendPid();
  if (backendPid) {
    process.kill(backendPid, "SIGKILL");
    await page.locator(".toast", { hasText: "restarting" }).waitFor({ timeout: 10_000 });
    await sleep(1500);
    await page.locator(`[data-pane="alpha"] textarea:not([disabled])`).waitFor({ timeout: 30_000 });
    await page.locator(`[data-pane="beta"] textarea:not([disabled])`).waitFor({ timeout: 30_000 });
    assert(true, "backend crash: auto-restart, panes reconnect");
  } else console.log("(skipped backend-crash check: could not find the backend pid)");

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
  await page.locator(".job-list li.ended", { hasText: "done" }).click();
  await page.locator(".modal .rep-job", { hasText: "run 2" }).waitFor({ timeout: 5000 });
  assert(await page.locator(".modal .rep-sum").count(), "clicking a job shows its runs with summaries");
  await page.keyboard.press("Escape");

  // skills: run yt-titles on a transcript from the dialog; it opens its own pane
  writeFileSync(join(dir, "transcript.txt"), "we build a robot that folds laundry and it fails twice before it works");
  await page.keyboard.press("Control+Shift+K");
  await page.locator(".modal .skill", { hasText: "yt-titles" }).click();
  await page.locator(".modal label:has-text('transcript') input").fill(join(dir, "transcript.txt"));
  await page.locator(".modal label:has-text('notes') textarea").fill("the failures are the story");
  await page.locator(".modal label:has-text('Agent') select").selectOption("mock");
  await page.locator(".modal button[type=submit]").click();
  await pane(page, "skill-yt-titles").locator(".msg.agent", { hasText: "A title" }).waitFor({ timeout: 15_000 });
  assert(true, "skills dialog runs a skill with a file parameter in its own pane");
  await pane(page, "skill-yt-titles").locator(".msg.user", { hasText: "folds laundry" }).first().waitFor({ timeout: 5000 });
  assert(true, "the transcript was inlined into the prompt");
  await page.keyboard.press("Control+Shift+K");
  await page.locator(".modal .skill", { hasText: "yt-titles" }).click();
  await page.locator(".modal button[type=submit]").click();
  await page.locator(".modal .err", { hasText: "missing required parameter" }).waitFor({ timeout: 5000 });
  assert(true, "missing required skill parameters are reported in the dialog");
  await page.keyboard.press("Escape");
  await pane(page, "skill-yt-titles").locator("button.close").click();
  // a required choice without a default runs with the option the dialog shows (the first)
  mkdirSync(join(process.env.HIVE_HOME!, "skills"), { recursive: true });
  writeFileSync(
    join(process.env.HIVE_HOME!, "skills", "choice-test.md"),
    "---\nname: choice-test\ndescription: required choice\nparams:\n  - name: tone\n    type: choice\n    required: true\n    choices: [curious, bold]\n---\nWrite one {{tone}} line.\n",
  );
  await page.keyboard.press("Control+Shift+K");
  await page.locator(".modal .skill", { hasText: "choice-test" }).click();
  await page.locator(".modal label:has-text('Agent') select").selectOption("mock");
  await page.locator(".modal button[type=submit]").click();
  await pane(page, "skill-choice-test").locator(".msg.user", { hasText: "Write one curious line." }).first().waitFor({ timeout: 15_000 });
  assert(true, "a required choice parameter is sent with the option shown");
  await pane(page, "skill-choice-test").locator("button.close").click();

  // recipes: studio opens a chat pane
  await command(page, "set up a team");
  await page.locator(".modal .recipe", { hasText: "Creator studio" }).click();
  await page.locator(".modal label:has-text('Main agent') select").selectOption("mock");
  await page.locator(".modal button[type=submit]").click();
  await page.locator(`[data-pane="studio"] textarea:not([disabled])`).waitFor({ timeout: 20_000 });
  assert(true, "a recipe sets up its team and opens the agent you talk to");
  await pane(page, "studio").locator("button.close").click();

  // Esc closes the Hive drawer without cancelling the turn of the pane you came from
  await pane(page, "beta").locator("textarea").fill("slow esc-check");
  await pane(page, "beta").locator("textarea").press("Enter");
  await pane(page, "beta").locator(".msg.agent", { hasText: "working slowly" }).waitFor({ timeout: 10_000 });
  await pane(page, "beta").locator("textarea").click();
  await page.keyboard.press("Control+I");
  await page.locator(".drawer").waitFor();
  assert(await page.evaluate(() => !!document.activeElement?.closest(".drawer")), "the drawer takes keyboard focus when it opens");
  await page.keyboard.press("Escape");
  await page.locator(".drawer").waitFor({ state: "detached", timeout: 2000 });
  await sleep(500);
  assert(
    (await pane(page, "beta").locator(".turn", { hasText: "cancelled" }).count()) === 0 && (await pane(page, "beta").locator(".st.st-working").count()) === 1,
    "Esc in the drawer closes it and leaves the agent's turn running",
  );
  assert(await activeIn(page, "beta"), "closing the drawer gives focus back to the pane");
  await page.keyboard.press("Escape");
  await pane(page, "beta").locator(".turn", { hasText: "cancelled" }).waitFor({ timeout: 10_000 });
  assert(true, "Esc in a pane still cancels its turn");

  // hive drawer: mail to the owner, report, blackboard, send as owner
  await pane(page, "alpha").locator("textarea").fill("tellowner: overnight run finished; bb ideas/dark-mode=add a dark mode toggle");
  await pane(page, "alpha").locator("textarea").press("Enter");
  await page.locator(".hive-btn .count").waitFor({ timeout: 10_000 });
  assert(true, "owner mail shows a badge on the Hive button");
  await page.keyboard.press("Control+I");
  await page.locator(".drawer .mail", { hasText: "overnight run finished" }).waitFor({ timeout: 5000 });
  assert(true, "inbox tab lists mail agents sent to the owner");
  await page.locator(".hive-btn .count").waitFor({ state: "detached", timeout: 5000 });
  assert(true, "opening the inbox marks it read");
  await page.locator(".drawer .seg button", { hasText: "Since you left" }).click();
  await page.locator(".drawer .rep-job", { hasText: "loop" }).waitFor({ timeout: 5000 });
  assert(true, "report tab summarizes job runs");
  await page.locator(".drawer .seg button", { hasText: "Blackboard" }).click();
  await page.locator(".drawer .bb-row", { hasText: "ideas/dark-mode" }).waitFor({ timeout: 5000 });
  assert(true, "blackboard tab shows entries agents wrote");
  await page.locator(".drawer .compose select").selectOption("beta");
  await page.locator(".drawer .compose input").fill("please look at the auth module");
  await page.locator(".drawer .compose input").press("Enter");
  await pane(page, "beta").locator(".sys", { hasText: "1 from owner" }).waitFor({ timeout: 10_000 });
  assert(true, "mail sent as owner wakes the agent");
  await page.screenshot({ path: join(shots, "hive-ui-drawer.png") });
  await page.keyboard.press("Escape");

  // usage: tokens per provider, a limit window with its reset, the pause switch
  await pane(page, "alpha").locator("textarea").fill("ratelimit-meta 42");
  await pane(page, "alpha").locator("textarea").press("Enter");
  await pane(page, "alpha").locator(".msg.user", { hasText: "ratelimit-meta 42" }).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(1000);
  await page.locator(".usage-chip").click();
  await page.locator(".drawer .usage-win", { hasText: "58% left" }).waitFor({ timeout: 20_000 });
  assert(await page.locator(".drawer .usage-win", { hasText: "resets in" }).count() > 0, "usage tab shows what's left in a window and when it resets");
  await page.locator(".drawer .usage-pause button").click();
  await page.locator(".drawer .usage-pause.on").waitFor({ timeout: 5000 });
  assert(true, "the pause switch stops automatic work");
  await page.screenshot({ path: join(shots, "hive-ui-usage.png") });
  await page.locator(".drawer .usage-pause button").click();
  await page.locator(".drawer .usage-pause:not(.on)").waitFor({ timeout: 5000 });
  // accounts: which agents are signed in / have keys, with how to fix it
  await page.locator(".drawer .seg button", { hasText: "Accounts" }).click();
  const gem = page.locator(".drawer .acct", { hasText: "Google Gemini (API)" });
  await gem.waitFor({ timeout: 60_000 });
  assert((await gem.getAttribute("class"))!.includes("no") && (await gem.textContent())!.includes("GEMINI_API_KEY"), "accounts tab: an API agent without its key shows ✗ and which variable to set");
  await page.screenshot({ path: join(shots, "hive-ui-accounts.png") });
  await page.keyboard.press("Escape");

  // ready: a turn that finishes while you're elsewhere turns the pane green (+ top-bar button); focusing clears it
  await pane(page, "beta").locator("textarea").click();
  await pane(page, "alpha").locator("textarea").fill("slow task");
  await pane(page, "alpha").locator("textarea").press("Enter");
  await pane(page, "beta").locator("textarea").click();
  await page.locator('[data-pane="alpha"].ready').waitFor({ timeout: 20_000 });
  assert(await pane(page, "alpha").locator(".st.st-done").count() === 1, "a finished agent you weren't looking at shows 'done' (not looked at yet)");
  assert(/ready/.test(await page.title()), "window title counts ready agents");
  await page.locator(".ready-btn").click();
  await page.locator('[data-pane="alpha"].ready').waitFor({ state: "detached", timeout: 5000 });
  assert(await activeIn(page, "alpha"), "the ready button jumps to the agent and clears the mark");
  await page.screenshot({ path: join(shots, "hive-ui-ready.png") });

  // command palette: jump to an agent by name, see every agent's state
  await page.keyboard.press("Control+k");
  await page.locator(".palette").waitFor({ timeout: 5000 });
  await page.screenshot({ path: join(shots, "hive-ui-palette.png") });
  await page.locator(".palette .pal-input").fill("beta");
  assert((await page.locator(".palette .pal-item.on").innerText()).includes("beta"), "palette filters agents by name");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement?.closest("[data-pane]")?.getAttribute("data-pane") === "beta", null, { timeout: 5000 });
  assert(await activeIn(page, "beta"), "palette jumps to the agent");

  // ✦ improve: rough idea → full prompt in the same composer, undo, then send to the same agent
  {
    const box = pane(page, "beta").locator("textarea");
    await box.fill("make the login remember the email");
    await pane(page, "beta").locator("button.improve").click();
    await until(async () => (await box.inputValue()).startsWith("IMPROVED:"), 30_000);
    assert((await box.inputValue()).includes("make the login remember the email"), "✦ turns the draft into a fuller prompt in the same box");
    await pane(page, "beta").locator("button.improve-undo").click();
    assert((await box.inputValue()) === "make the login remember the email", "undo brings the draft back");
    await box.press("Control+Shift+Enter");
    await until(async () => (await box.inputValue()).startsWith("IMPROVED:"), 30_000);
    await box.press("Enter");
    await pane(page, "beta").locator(".msg.user", { hasText: "IMPROVED: make the login remember the email" }).waitFor({ timeout: 10_000 });
    assert(true, "Ctrl+Shift+Enter improves, Enter sends it to the same agent");
  }

  // board: Ctrl+J, quick add, Esc closes; stats and themes from the palette
  await page.keyboard.press("Control+j");
  await page.locator(".kanban").waitFor({ timeout: 5000 });
  await page.locator(".kb-add input").fill("Card from the UI test");
  await page.keyboard.press("Enter");
  await page.locator(".kb-card", { hasText: "Card from the UI test" }).waitFor({ timeout: 5000 });
  assert((await page.locator(".kb-draft .kb-card", { hasText: "Card from the UI test" }).count()) === 1, "board: a quick-added card lands in Draft");
  await page.keyboard.press("Escape");
  await page.locator(".kanban").waitFor({ state: "detached", timeout: 5000 });
  assert(true, "board: Esc closes it");
  await command(page, "token stats");
  await page.locator(".stats").waitFor({ timeout: 5000 });
  assert((await page.locator(".stats-total .big").innerText()).length > 0, "token stats open from the palette");
  await page.keyboard.press("Escape");
  await command(page, "theme: oled");
  assert((await page.evaluate("document.documentElement.dataset.theme")) === "oled" && (await page.evaluate("getComputedStyle(document.body).backgroundColor")) === "rgb(0, 0, 0)", "OLED theme: true black background");
  await command(page, "theme: paper");
  assert((await page.evaluate("document.documentElement.dataset.tone")) === "light", "Paper is a light theme");
  await command(page, "theme: dark");

  // code view: open a file from the palette, highlighted; select lines, "Explain" goes to a teacher (started on the spot)
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "hello.ts"), "// greet someone by name\nexport function greet(name: string): string {\n  const message = `Hello, ${name}!`;\n  return message;\n}\n");
  await command(page, "open file");
  await page.locator(".code-view").waitFor({ timeout: 5000 });
  assert(await page.evaluate(() => document.activeElement?.closest(".code-find") != null), "Open file… opens the code view with the find box focused");
  await page.locator(".code-find input").fill("hello");
  await page.locator(".code-tree .code-node", { hasText: "src/hello.ts" }).waitFor({ timeout: 5000 });
  await page.keyboard.press("Enter");
  await page.locator(".code-lines .cl").first().waitFor({ timeout: 5000 });
  assert((await page.locator(".code-lines .cl").count()) === 5 && (await page.locator(".code-path").innerText()).includes("src/hello.ts"), "the file opens with one row per line");
  assert((await page.locator(".code-lines .hljs-keyword").count()) >= 3 && (await page.locator(".code-lines .hljs-comment").count()) === 1 && (await page.locator(".code-lines .hljs-string").count()) >= 1, "syntax highlighting: keyword, comment and string tokens");
  const [kwColor, textColor] = await page.evaluate(() => [getComputedStyle(document.querySelector(".code-lines .hljs-keyword")!).color, getComputedStyle(document.querySelector(".code-lines .lc")!).color]);
  assert(kwColor !== textColor, `keywords are coloured from the theme (${kwColor} vs ${textColor})`);
  await page.locator('.cl[data-row="1"] .ln').click();
  await page.locator('.cl[data-row="3"] .ln').click({ modifiers: ["Shift"] });
  assert((await page.locator(".cl.sel").count()) === 3, "click + Shift+click on line numbers selects lines 2-4");
  await page.locator(".code-ask button", { hasText: "Explain" }).click();
  const td = page.locator(".modal", { hasText: "Start a teacher" });
  await td.waitFor({ timeout: 5000 });
  assert(true, "no teacher yet: Explain offers to start one");
  await td.locator("select").selectOption("mock");
  await td.locator("button[type=submit]").click();
  await page.locator('[data-pane="teacher"]').waitFor({ state: "attached", timeout: 20_000 });
  const asked = page.locator(".code-dock .msg.user", { hasText: "const message" });
  await asked.waitFor({ timeout: 20_000 });
  const askedText = await asked.innerText();
  assert(askedText.includes("src/hello.ts lines 2–4") && askedText.includes("return message;") && askedText.includes("```ts") && askedText.includes("Explain what these lines do"), "Explain sends the path, line range and the code in a fenced block to the teacher");
  assert((await pane(page, "teacher").locator(".msg.user", { hasText: "const message" }).count()) === 1, "the question is in the teacher's own pane too");
  await page.locator(".code-dock .msg.agent", { hasText: "done" }).first().waitFor({ timeout: 20_000 });
  assert(true, "the teacher answers in the docked transcript next to the code");
  await page.screenshot({ path: join(shots, "hive-ui-code.png") });
  await page.locator('.cl[data-row="0"] .ln').click();
  await page.locator(".code-ask button", { hasText: "Quiz me" }).click();
  await page.locator(".code-dock .msg.user", { hasText: "Quiz me" }).waitFor({ timeout: 10_000 });
  assert((await page.locator(".modal").count()) === 0, "with a teacher running, questions go straight to it");
  await page.keyboard.press("Escape");
  assert((await page.locator(".cl.sel").count()) === 0 && (await page.locator(".code-view").count()) === 1, "Esc clears the selection first");
  await page.locator(".code-tabs button", { hasText: "Changes" }).click();
  await page.locator(".code-side .small", { hasText: /changed vs|repository/ }).first().waitFor({ timeout: 10_000 });
  assert(true, "Changes tab lists what changed");
  await page.keyboard.press("Escape");
  await page.locator(".code-view").waitFor({ state: "detached", timeout: 2000 });
  await page.keyboard.press("Control+p");
  await page.locator(".code-view").waitFor({ timeout: 2000 });
  assert(true, "Ctrl+P opens the code view");
  await page.keyboard.press("Escape");
  await page.locator(".code-view").waitFor({ state: "detached", timeout: 2000 });
  await page.keyboard.press("Control+1");
  await command(page, "explain every change by alpha");
  await page.locator(".toast", { hasText: "Explain every change" }).first().waitFor({ timeout: 5000 });
  await page.keyboard.press("Control+1");
  await command(page, "explain every change by alpha: turn off");
  await page.locator(".toast", { hasText: "is off for alpha" }).waitFor({ timeout: 5000 });
  assert(true, "explain every change toggles per agent from the palette");
  await pane(page, "teacher").locator("button.close").click();
  await pane(page, "teacher").waitFor({ state: "detached", timeout: 5000 });

  // long prompt editor: write, save as skill with a parameter, send
  await pane(page, "alpha").locator("textarea").fill("draft line");
  await pane(page, "alpha").locator("button.expand").click();
  const ed = page.locator(".modal.wide");
  await ed.locator("textarea.prompt-editor").fill("Audit the {{area}} of this app.\nBe thorough.\nroll call");
  await ed.locator("button", { hasText: "Save as skill" }).click();
  await ed.locator("label:has-text('Skill name') input").fill("ui-audit-test");
  await ed.locator("button", { hasText: "Save skill" }).click();
  await page.locator(".toast", { hasText: "skill ui-audit-test saved" }).waitFor({ timeout: 5000 });
  assert(existsSync(join(process.env.HIVE_HOME!, "skills", "ui-audit-test.md")) && readFileSync(join(process.env.HIVE_HOME!, "skills", "ui-audit-test.md"), "utf8").includes("- name: area"), "prompt saved as a skill with {{area}} as a parameter");
  await ed.locator("button", { hasText: "Send to alpha" }).click();
  await pane(page, "alpha").locator(".msg.user", { hasText: "Be thorough." }).waitFor({ timeout: 10_000 });
  assert(true, "the editor sends the long prompt to the agent");
  // ✦ Improve opens the prompt-engineer skill with the draft filled in
  await pane(page, "alpha").locator("button.expand").click();
  await ed.locator("textarea.prompt-editor").fill("an audit prompt for my app");
  await ed.locator("button", { hasText: "Improve with prompt-engineer" }).click();
  await page.locator(".modal .skill.on", { hasText: "prompt-engineer" }).waitFor({ timeout: 5000 });
  assert((await page.locator(".modal label:has-text('goal') textarea").inputValue()) === "an audit prompt for my app", "✦ Improve opens prompt-engineer with the draft as the goal");
  await page.keyboard.press("Escape");

  // vertical layout: forced vertical → one column, no sidebar; auto on a tall window does the same
  await command(page, "layout"); // auto → vertical
  await page.locator(".app.vertical").waitFor({ timeout: 5000 });
  const cols = await page.locator(".grid").evaluate((g) => getComputedStyle(g).gridTemplateColumns.split(" ").length);
  assert(cols === 1 && (await page.locator(".sidebar").count()) === 0, `vertical layout: one column, no sidebar (${cols})`);
  await page.screenshot({ path: join(shots, "hive-ui-vertical-forced.png") });
  await command(page, "layout"); // → horizontal
  await command(page, "layout"); // → auto
  await page.setViewportSize({ width: 720, height: 1280 }).catch(() => {});
  await page.locator(".app.vertical").waitFor({ timeout: 5000 });
  assert(true, "auto layout goes vertical on a 9:16 window");
  await page.screenshot({ path: join(shots, "hive-ui-vertical.png") });
  await page.setViewportSize({ width: 1600, height: 950 }).catch(() => {});
  await page.locator(".app:not(.vertical)").waitFor({ timeout: 5000 });

  // link by drag and drop: alpha's name onto beta's pane → review group → held message → release
  await pane(page, "alpha").locator(".pname").dragTo(pane(page, "beta").locator(".transcript, .pane-sub").first());
  const ld = page.locator(".modal", { hasText: "Link agents" });
  await ld.waitFor({ timeout: 5000 });
  await ld.locator("label.radio", { hasText: "Review" }).locator("input").check();
  await ld.locator("button[type=submit]").click();
  await pane(page, "beta").locator(".group-chip", { hasText: "@alpha-beta" }).waitFor({ timeout: 5000 });
  assert(await pane(page, "alpha").locator(".group-chip", { hasText: "@alpha-beta" }).count() === 1, "dragging one pane onto another links them (group chip on both)");
  await pane(page, "alpha").locator("textarea").fill("send beta: please check the login flow");
  await pane(page, "alpha").locator("textarea").press("Enter");
  await pane(page, "beta").locator(".group-chip .badge").waitFor({ timeout: 10_000 });
  assert(true, "a message between linked agents in review mode waits for you (badge)");
  await page.keyboard.press("Control+I");
  await page.locator(".drawer .held-list .gmsg", { hasText: "please check the login flow" }).waitFor({ timeout: 5000 });
  assert(true, "everything waiting for review is also listed in the Inbox");
  await page.keyboard.press("Escape");
  // alignment: every visible item in a row shares the row's vertical center (±1px)
  const misaligned = await alignment(page);
  writeFileSync(join(shots, "alignment.json"), JSON.stringify(misaligned, null, 2));
  // close-ups at 3x for checking spacing by eye (ALIGN_SHOTS=1; a 3x window crashes small CI displays)
  if (process.env.ALIGN_SHOTS === "1") {
    const vp = page.viewportSize() ?? { width: 1600, height: 950 };
    await page.setViewportSize({ width: vp.width * 3, height: vp.height * 3 }).catch(() => {});
    await page.evaluate(`document.documentElement.style.zoom = "3"; document.body.classList.add("no-toasts")`);
    await page.addStyleTag({ content: ".no-toasts .toasts { display: none !important; }" });
    await page.waitForTimeout(300);
    for (const [file, sel] of [["head", '[data-pane="alpha"] .pane-head'], ["side", ".agent-list"], ["groups", ".group-item"]] as const)
      await page.locator(sel).first().screenshot({ path: join(shots, `align-${file}.png`) }).catch(() => {});
    await page.locator(".topbar").screenshot({ path: join(shots, "align-top.png"), clip: undefined }).catch(() => {});
    await page.evaluate(`document.documentElement.style.zoom = "1"; document.body.classList.remove("no-toasts")`);
    await page.setViewportSize(vp).catch(() => {});
  }
  assert(misaligned.length === 0, `rows are vertically aligned${misaligned.length ? ": " + misaligned.slice(0, 6).map((m) => `${m.row} > ${m.el} off by ${m.dy}px`).join("; ") : ""}`);
  await pane(page, "beta").locator(".group-chip").click();
  const gc = page.locator(".modal.wide", { hasText: "@alpha-beta" });
  await gc.locator(".gmsg.held", { hasText: "please check the login flow" }).waitFor({ timeout: 5000 });
  await page.screenshot({ path: join(shots, "hive-ui-group-chat.png") });
  await gc.locator(".gmsg.held button", { hasText: "Release" }).click();
  await gc.locator(".gmsg.held").waitFor({ state: "detached", timeout: 5000 });
  await page.keyboard.press("Escape");
  await pane(page, "beta").locator(".msg.agent", { hasText: "Got mail from alpha" }).waitFor({ timeout: 15_000 });
  assert(true, "released from the group chat: the other agent gets it and acts");
  await page.screenshot({ path: join(shots, "hive-ui-linked.png") });

  // verdict mode: one prompt to two agents, a judge picks the best parts, then build the merge
  await page.locator(".topbar button", { hasText: "Verdict" }).click();
  const vd = page.locator(".modal.wide", { hasText: "several agents, one judge" });
  await vd.locator("textarea.verdict-prompt").fill("verdict-task: three title ideas for my video");
  await vd.locator(".seg button", { hasText: "Text" }).click();
  for (const l of await vd.locator("fieldset label.radio").all()) if (await l.locator("input").isChecked()) await l.locator("input").uncheck();
  await vd.locator("fieldset label.radio", { hasText: /^\s*Mock agent \(tests\)/ }).locator("input").check();
  await vd.locator("fieldset label.radio", { hasText: "Mock agent 2" }).locator("input").check();
  await vd.locator("label:has-text('Judge') select").selectOption("mock");
  assert((await vd.textContent())!.includes("3 agent turns"), "verdict setup shows the cost (agents + judge)");
  await vd.locator("button", { hasText: "Start" }).click();
  const vv = page.locator(".modal.wide", { hasText: "Verdict #" });
  await vv.locator(".verdict-text", { hasText: "VERDICT: base = Solution A" }).waitFor({ timeout: 60_000 });
  assert((await vv.locator(".vc.done").count()) >= 2 && (await vv.locator(".vc.base").count()) === 1, "contenders finished; the judge's base is highlighted");
  await page.screenshot({ path: join(shots, "hive-ui-verdict.png") });
  await vv.locator("button", { hasText: "Build merged version" }).click();
  await vv.locator(".ok", { hasText: "built by" }).waitFor({ timeout: 30_000 });
  assert(true, "build merged version: the base solution's author rewrites it from the verdict");
  await page.keyboard.press("Escape");

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
  // Ctrl+M right after closing the focused pane: nothing to maximize, the grid keeps its columns
  await pane(page, "gamma").locator("textarea").click();
  await pane(page, "gamma").locator("button.close").click();
  await pane(page, "gamma").waitFor({ state: "detached", timeout: 5000 });
  await page.keyboard.press("Control+M");
  await sleep(300);
  const after = JSON.parse(readFileSync(join(projectDir(dir), "ui.json"), "utf8"));
  assert(
    (await page.locator(".pane").count()) === 2 && !after.maximized && (await page.locator(".grid").evaluate((g) => getComputedStyle(g).gridTemplateColumns.split(" ").length)) === 2,
    "Ctrl+M after closing the focused pane doesn't save a stale maximized pane",
  );
  // device panes: the sandboxed browser opens from the palette and streams the page as pictures
  if (!findChromium()) console.log("⏭  no Chromium: skipping the browser pane test");
  else {
    const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end("<title>Pane test</title><h1 style='font-size:80px'>Hello pane</h1>"));
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    await command(page, "Open browser");
    await page.locator(".device-dock .browser-pane").waitFor({ timeout: 5000 });
    assert((await page.locator(".dv-badge").innerText()).includes("sandboxed"), "browser pane opens from the palette with the sandbox badge");
    await page.locator(".dv-url").fill(`127.0.0.1:${(site.address() as any).port}`);
    await page.locator(".dv-url").press("Enter");
    await page.waitForFunction(() => (document.querySelector(".browser-pane .dv-view img") as HTMLImageElement | null)?.src.startsWith("data:image/jpeg"), null, { timeout: 30_000 });
    assert(await page.locator(".dv-title", { hasText: "Pane test" }).count(), "the page loads in the sandboxed browser and frames reach the pane");
    await page.screenshot({ path: join(shots, "hive-ui-browser.png") });
    await page.locator(".dv-tab button[aria-label='close Browser pane']").click();
    await page.locator(".device-dock").waitFor({ state: "detached", timeout: 5000 });
    site.close();
  }
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
