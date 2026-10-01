/**
 * `hive tui`: the pane grid in a terminal. Opens your last layout, or a team
 * of four agents with roles (planner, coder, reviewer, tester) linked in one
 * group; runs jobs and mail delivery like `hive serve`. Works in Windows
 * Terminal, GNOME Terminal, Konsole, iTerm, tmux.
 */
import * as readline from "node:readline";
import { join } from "node:path";
import { Hub } from "../core/hub.js";
import { Scheduler } from "../core/scheduler.js";
import { projectDir } from "../core/home.js";
import { AGENTS } from "../core/agents.js";
import { RECIPES } from "../core/recipes.js";
import { TuiController } from "./controller.js";
import { cursorColumn, render } from "./render.js";

export interface TuiOptions {
  cwd: string;
  db: string;
  team?: string;
  kind?: string;
  alt?: string;
  fresh?: boolean;
}

export async function runTui(o: TuiOptions): Promise<void> {
  const out = process.stdout;
  const inp = process.stdin;
  if (!inp.isTTY || !out.isTTY) throw new Error("hive tui needs an interactive terminal");
  // Check what we can before taking over the screen, so mistakes print normally.
  if (o.team && !RECIPES[o.team]) throw new Error(`unknown team "${o.team}" (${Object.keys(RECIPES).join(", ")})`);
  for (const k of [o.kind, o.alt]) if (k && !AGENTS[k]) throw new Error(`unknown agent "${k}" (${Object.keys(AGENTS).join(", ")})`);
  let ctl!: TuiController;
  const hub = new Hub({
    hiveDb: o.db,
    pollMs: 1000,
    onEvent: (a, e) => ctl.onEvent(a, e),
    defaults: { askPermission: (req, agent, signal) => ctl.askPermission(req, agent, signal) },
  });
  const scheduler = new Scheduler({ hub, onJob: () => {} });
  ctl = new TuiController(hub, o.cwd, { layoutFile: join(projectDir(o.cwd), "tui.json"), kind: o.kind, alt: o.alt });

  // ---- screen ----
  let pending = false;
  let lastFrame: string[] = [];
  let restored = false;
  const draw = () => {
    if (restored) return; // the terminal is back to normal (quitting)
    pending = false;
    const cols = out.columns || 100;
    const rows = out.rows || 30;
    const v = ctl.view();
    const frame = render(v, cols, rows);
    let buf = "\x1b[?25l";
    for (let i = 0; i < frame.length; i++) if (frame[i] !== lastFrame[i]) buf += `\x1b[${i + 1};1H${frame[i]}\x1b[0m\x1b[K`;
    lastFrame = frame;
    buf += `\x1b[${rows};${cursorColumn(v, cols) + 1}H\x1b[?25h`;
    out.write(buf);
  };
  const schedule = () => {
    if (pending) return;
    pending = true;
    setTimeout(draw, 33);
  };
  ctl.on("change", schedule);
  out.on("resize", () => {
    lastFrame = [];
    out.write("\x1b[2J");
    schedule();
  });
  // alternate screen + bracketed paste (pasted text arrives between \x1b[200~ and \x1b[201~)
  out.write("\x1b[?1049h\x1b[?2004h\x1b[2J");
  // Idempotent and synchronous: runs on quit, on errors, and on any process exit.
  const restore = () => {
    if (restored) return;
    restored = true;
    try {
      if (inp.isRaw) inp.setRawMode(false);
    } catch {}
    out.write("\x1b[0m\x1b[?25h\x1b[?2004l\x1b[?1049l");
  };
  process.on("exit", restore);

  // ---- keys ----
  readline.emitKeypressEvents(inp);
  inp.setRawMode(true);
  let quitArmed = 0;
  const quit = async () => {
    restore();
    inp.pause();
    out.write("closing agents…\n");
    await scheduler.stop();
    await hub.close();
    process.exit(0);
  };
  ctl.on("quit", () => void quit());
  let paste: string | null = null;
  inp.on("keypress", (str: string | undefined, key: readline.Key) => {
    const name = key?.name;
    // A paste goes into the prompt as one block: Enter / Tab inside it are text, not keys.
    if (name === "paste-start") {
      paste = "";
      return;
    }
    if (name === "paste-end") {
      const text = (paste ?? "").replace(/\r\n?/g, "\n");
      paste = null;
      return ctl.insert(text);
    }
    if (paste !== null) {
      paste += name === "return" || name === "enter" ? "\n" : name === "tab" ? "\t" : (str ?? key?.sequence ?? "");
      return;
    }
    if (key?.ctrl && name === "c") {
      if (Date.now() - quitArmed < 1500) return void quit();
      quitArmed = Date.now();
      return ctl.say("press Ctrl+C again to quit (agents are closed; sessions resume next time)");
    }
    if (ctl.overlay && (name === "escape" || name === "return" || name === "q")) {
      ctl.overlay = undefined;
      return schedule();
    }
    if (key?.meta && /^[1-9]$/.test(name ?? str ?? "")) return ctl.setFocus(Number(name ?? str) - 1);
    switch (name) {
      case "tab":
        return ctl.setFocus(ctl.focus + (key.shift ? -1 : 1));
      case "return":
        return void ctl.submit();
      case "escape":
        if (ctl.input) {
          ctl.input = "";
          ctl.cursor = 0;
          return schedule();
        }
        return void ctl.stopFocused().catch((e) => ctl.say(`✗ ${e?.message ?? e}`));
      case "backspace":
        return ctl.backspace();
      case "delete":
        return ctl.deleteForward();
      case "left":
        return ctl.left();
      case "right":
        return ctl.right();
      case "home":
        ctl.cursor = 0;
        return schedule();
      case "end":
        ctl.cursor = ctl.input.length;
        return schedule();
      case "up":
        return ctl.historyUp();
      case "down":
        return ctl.historyDown();
      case "pageup":
      case "pagedown": {
        const p = ctl.panes[ctl.focus];
        // (render clamps scroll to the pane's wrapped line count)
        if (p) p.scroll = Math.max(0, p.scroll + (name === "pageup" ? 10 : -10));
        return schedule();
      }
    }
    if (!str || key?.ctrl || key?.meta) return;
    // y / n answer a permission question when nothing is typed
    if (!ctl.input && (str === "y" || str === "n") && ctl.panes[ctl.focus]?.pending) return void ctl.answer(str === "y");
    ctl.insert(str);
  });
  process.on("SIGTERM", () => void quit());

  // ---- start ----
  try {
    hub.run();
    scheduler.start();
    setInterval(schedule, 1000).unref(); // status, unread counts
    draw();
    const saved = o.fresh ? [] : ctl.saved();
    if (saved.length) {
      ctl.say(`reopening ${saved.map((s) => s.name).join(", ")} (resuming their sessions) · /help`, 8000);
      await ctl.restore(saved);
    } else {
      await ctl.team(o.team ?? "squad").catch((e) => ctl.say(`✗ ${e?.message ?? e}`, 15000));
    }
  } catch (e) {
    // put the terminal back before the caller prints the error
    restore();
    throw e;
  }
}
