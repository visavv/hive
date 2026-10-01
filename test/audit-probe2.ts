/** Audit passes 2–3: layout at real window sizes, alignment/overflow, modal focus, recovery cases. Not part of npm test. */
import { _electron as electron, type Page } from "playwright-core";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { freshDir } from "./util.js";

const dir = freshDir(".hive-audit-ui2");
process.env.HIVE_HOME = freshDir(".hive-audit-ui2-home");
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
const log = (k: string, v: unknown) => console.log(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
await page.setViewportSize({ width: 1600, height: 950 });
await page.locator(".welcome").waitFor({ timeout: 20_000 });

async function add(name: string) {
  await page.keyboard.press("Control+N");
  const dlg = page.locator(".modal");
  await dlg.locator("select").first().selectOption("mock");
  await dlg.locator("label:has-text('Name') input").fill(name);
  await dlg.locator("button[type=submit]").click();
  const err = await dlg.locator(".err").textContent({ timeout: 800 }).catch(() => null);
  if (err) {
    await page.keyboard.press("Escape");
    return err;
  }
  await page.locator(`[data-pane="${name}"] textarea:not([disabled])`).waitFor({ timeout: 15_000 });
  return "ok";
}

// Fixed findings, re-checked in the UI
log("UX-001 owner in dialog", await add("owner"));
log("UX-002 unicode in dialog", await add("äijä"));
log("panes after invalid names", await page.locator("[data-pane]").count());

// A realistic set: long names, groups
for (const n of ["coder", "reviewer", "security-reviewer-long-name", "studio"]) await add(n);
await page.evaluate(() => (window as any).hiveBridge);
// link coder+reviewer (review mode) via the 🔗 button (keyboard-accessible path)
await page.locator('[data-pane="coder"] button[aria-label="link with another agent"]').click();
const ld = page.locator(".modal", { hasText: "Link agents" });
await ld.locator('select[aria-label="add an agent"]').selectOption("reviewer");
await ld.locator("label.radio", { hasText: "Review" }).locator("input").check();
await ld.locator("button[type=submit]").click();
await page.locator('[data-pane="reviewer"] .group-chip').waitFor({ timeout: 5000 });
log("link via 🔗 button (no drag); group chip text", await page.locator('[data-pane="reviewer"] .group-chip').first().textContent());

// Measure overflow / clipping at common window sizes
const measure = () =>
  page.evaluate(`(() => {
    const over = (el) => (el ? Math.round(el.scrollWidth - el.clientWidth) : null);
    const heads = [...document.querySelectorAll(".pane-head")].map((h) => {
      const r = h.getBoundingClientRect();
      const kids = [...h.children].map((c) => c.getBoundingClientRect());
      const clipped = kids.filter((k) => k.right > r.right + 1 || k.left < r.left - 1).length;
      return { w: Math.round(r.width), overflow: over(h), clipped };
    });
    const tb = document.querySelector(".topbar");
    const tbr = tb.getBoundingClientRect();
    const tbClipped = [...tb.children].filter((c) => c.getBoundingClientRect().right > tbr.right + 1).map((c) => (c.textContent || c.className).trim().slice(0, 20));
    return { topbarOverflow: over(tb), topbarClipped: tbClipped, topbarH: Math.round(tbr.height), heads, vertical: document.querySelector(".app").classList.contains("vertical") };
  })()`) as Promise<any>;
for (const [w, h] of [[1920, 1080], [1366, 768], [1280, 720], [1440, 2560 / 2], [720, 1280]] as const) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(500);
  log(`layout ${w}x${h}`, await measure());
  await page.screenshot({ path: join(shots, `p2-layout-${w}x${h}.png`) });
}
await page.setViewportSize({ width: 1920, height: 1080 });
for (const c of [3, 4]) {
  while ((await page.locator(".cols").textContent())!.match(/(\d+) cols/)![1] !== String(c)) await page.locator('.cols button[aria-label="more columns"]').click();
  await page.waitForTimeout(300);
  log(`layout 1920 ${c} cols`, (await measure()).heads);
  await page.screenshot({ path: join(shots, `p2-layout-1920-${c}cols.png`) });
}

// Modal focus: does Tab stay inside an open dialog?
await page.keyboard.press("Control+N");
await page.locator(".modal").waitFor();
const escaped: string[] = [];
for (let i = 0; i < 25; i++) {
  await page.keyboard.press("Tab");
  const inModal = await page.evaluate(() => !!document.activeElement?.closest(".modal"));
  if (!inModal) escaped.push(await page.evaluate(() => document.activeElement?.tagName + "." + (document.activeElement as HTMLElement)?.className));
}
log("modal focus escapes (Tab ×25)", escaped.slice(0, 3).concat(escaped.length ? [`…${escaped.length} times`] : []));
await page.keyboard.press("Escape");
log("toasts container has aria-live", await page.locator(".toasts[aria-live]").count());

// Group deleted while a message is held → where does the held message go?
await page.locator('[data-pane="coder"] textarea').fill("send reviewer: please review");
await page.locator('[data-pane="coder"] textarea').press("Enter");
await page.locator('[data-pane="reviewer"] .group-chip .badge').waitFor({ timeout: 10_000 });
await page.locator('[data-pane="reviewer"] .group-chip').click();
page.once("dialog", (d) => void d.accept());
await page.locator(".modal.wide button", { hasText: "Delete group" }).click();
await page.waitForTimeout(2500);
log("after trying to delete a group with a held message: chips", await page.locator(".group-chip").count());
log("toast", await page.locator(".toast").allTextContents());
await page.keyboard.press("Escape");

// Esc in the prompt editor with a long draft: is the draft kept?
await page.locator('[data-pane="studio"] textarea').fill("short");
await page.locator('[data-pane="studio"] button.expand').click();
await page.locator("textarea.prompt-editor").fill("a long draft ".repeat(50));
await page.keyboard.press("Escape");
log("prompt editor Esc keeps the draft", (await page.locator('[data-pane="studio"] textarea').inputValue()).length > 100);

log("renderer errors", errors.slice(0, 5));
await app.close();
