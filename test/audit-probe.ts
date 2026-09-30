/** Audit pass 1: hands-on UI probes (many agents, odd input, narrow window). Not part of npm test. */
import { _electron as electron, type Page } from "playwright-core";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { freshDir } from "./util.js";

const dir = freshDir(".hive-audit-ui");
process.env.HIVE_HOME = freshDir(".hive-audit-ui-home");
const shots = resolve("audit/evidence");
const electronBin = createRequire(import.meta.url)("electron") as unknown as string;
const app = await electron.launch({
  executablePath: electronBin,
  args: [resolve("dist-ui/main.cjs"), "--cwd", dir, "--no-sandbox"],
  env: { ...process.env, HIVE_NODE: process.execPath, HIVE_HOTKEY: "CommandOrControl+Alt+F12" } as Record<string, string>,
});
const page: Page = await app.firstWindow();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.setViewportSize({ width: 1600, height: 950 });
await page.locator(".welcome").waitFor({ timeout: 20_000 });
const log = (k: string, v: unknown) => console.log(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);

async function tryAdd(name: string) {
  await page.keyboard.press("Control+N");
  const dlg = page.locator(".modal");
  await dlg.locator("select").first().selectOption("mock");
  await dlg.locator("label:has-text('Name') input").fill(name);
  await dlg.locator("button[type=submit]").click();
  const ok = await page.locator(`[data-pane="${name}"] textarea:not([disabled])`).waitFor({ timeout: 15_000 }).then(() => true, () => false);
  const err = await dlg.locator(".err").textContent({ timeout: 500 }).catch(() => null);
  if (await dlg.count()) await page.keyboard.press("Escape");
  return { ok, err };
}

// P1 invalid / odd names
log("P1 empty name", await tryAdd(""));
log("P1 space name", await tryAdd("my agent"));
log("P1 unicode name", await tryAdd("äijä"));
log("P1 owner", await tryAdd("owner"));
log("P1 owner toasts", await page.locator(".toast").allTextContents());
log("P1 panes after owner", await page.evaluate(() => [...document.querySelectorAll("[data-pane]")].map((e) => e.getAttribute("data-pane") + ":" + (e.querySelector(".pane-error")?.textContent ?? "ok"))));
log("P1 41 chars", await tryAdd("a".repeat(41)));
// P2 many agents
for (let i = 1; i <= 9; i++) await tryAdd(`agent${i}`);
await page.waitForTimeout(800);
const grid = await page.locator(".grid-wrap").evaluate((el) => ({ scrollH: el.scrollHeight, clientH: el.clientHeight, overflowY: getComputedStyle(el).overflowY }));
log("P2 9 agents horizontal grid", grid);
await page.screenshot({ path: join(shots, "p2-nine-agents-horizontal.png") });
log("P2 duplicate", await tryAdd("agent1"));
// P3 vertical with 9 agents
await page.setViewportSize({ width: 720, height: 1280 });
await page.waitForTimeout(500);
const v = await page.locator(".grid-wrap").evaluate((el) => ({ scrollH: el.scrollHeight, clientH: el.clientHeight }));
log("P3 vertical scroll", v);
const paneH = await page.locator(".pane").first().evaluate((el) => el.getBoundingClientRect().height);
log("P3 pane height", paneH);
await page.screenshot({ path: join(shots, "p3-nine-agents-vertical.png") });
// P3b Ctrl+9 scrolls pane into view
await page.keyboard.press("Control+9");
await page.waitForTimeout(400);
log("P3b active element pane", await page.evaluate(() => document.activeElement?.closest("[data-pane]")?.getAttribute("data-pane") ?? document.activeElement?.tagName));
const inView = await page.locator('[data-pane="agent8"]').evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.top < window.innerHeight; });
log("P3b Ctrl+9 brings the 9th pane (agent8, owner pane is 1st) into view", inView);
// P4 broadcast empty / whitespace
await page.locator(".broadcast input").fill("   ");
log("P4 send disabled for whitespace", await page.locator(".broadcast button", { hasText: "Send" }).isDisabled());
// P5 very long prompt into a pane
await page.setViewportSize({ width: 1600, height: 950 });
const long = "x".repeat(60_000);
await page.locator('[data-pane="agent1"] textarea').fill(long);
const t0 = Date.now();
await page.locator('[data-pane="agent1"] textarea').press("Enter");
await page.locator('[data-pane="agent1"] .msg.user').last().waitFor({ timeout: 10_000 });
log("P5 60k-char prompt rendered ms", Date.now() - t0);
// P6 keyboard: Tab order from composer reaches pane buttons? focus visible?
await page.locator('[data-pane="agent1"] textarea').focus();
const outline = await page.evaluate(() => {
  const b = document.querySelector('[data-pane="agent1"] .pane-actions button') as HTMLElement;
  b.focus();
  const cs = getComputedStyle(b);
  return { outline: cs.outlineStyle + " " + cs.outlineWidth, boxShadow: cs.boxShadow };
});
log("P6 focus style on pane action button", outline);
const unnamed = await page.evaluate(() => [...document.querySelectorAll("button")].filter((b) => !(b.textContent || "").trim().replace(/[^\w]/g, "") && !b.getAttribute("aria-label") && !b.title).length);
log("P6 buttons without a text/aria-label/title", unnamed);
const iconOnly = await page.evaluate(() => [...document.querySelectorAll("button")].filter((b) => !(b.textContent || "").replace(/[^\p{L}\p{N}]/gu, "") && !b.getAttribute("aria-label")).map((b) => b.title || b.textContent).slice(0, 12));
log("P6 icon-only buttons relying on title only (sample)", iconOnly);
// P7 close pane with job confirm etc.: close agent9 then reopen from "other agents"
await page.locator('[data-pane="agent9"] button.close').click();
await page.waitForTimeout(600);
log("P7 closed agent listed under other agents", await page.locator(".sidebar", { hasText: "agent9" }).count());
// P8 contrast of dim text
const contrast = await page.evaluate(`(() => {
  const lum = (c) => { const m = c.match(/\\d+/g).map(Number).slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]; };
  const out = {};
  for (const sel of [".pane-sub", ".side-head", ".dim", ".kind"]) {
    const el = document.querySelector(sel); if (!el) continue;
    const fg = getComputedStyle(el).color;
    const bg = getComputedStyle(document.querySelector(".pane")).backgroundColor;
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    out[sel] = +((a + 0.05) / (b + 0.05)).toFixed(2);
  }
  return out;
})()`);
log("P8 dim text contrast", contrast);
log("renderer errors", errors.slice(0, 5));
await app.close();
