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
  const draw = () => {
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
  out.write("\x1b[?1049h\x1b[2J"); // alternate screen
  const restore = () => out.write("\x1b[0m\x1b[?25h\x1b[?1049l");

  // ---- keys ----
  readline.emitKeypressEvents(inp);
  inp.setRawMode(true);
  let quitArmed = 0;
  const quit = async () => {
    inp.setRawMode(false);
    inp.pause();
    restore();
    out.write("closing agents…\n");
    await scheduler.stop();
    await hub.close();
    process.exit(0);
  };
  ctl.on("quit", () => void quit());
  inp.on("keypress", (str: string | undefined, key: readline.Key) => {
    const name = key?.name;
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
        return void ctl.submit("/stop");
      case "backspace":
        if (ctl.cursor > 0) {
          ctl.input = ctl.input.slice(0, ctl.cursor - 1) + ctl.input.slice(ctl.cursor);
          ctl.cursor--;
        }
        return schedule();
      case "delete":
        ctl.input = ctl.input.slice(0, ctl.cursor) + ctl.input.slice(ctl.cursor + 1);
        return schedule();
      case "left":
        ctl.cursor = Math.max(0, ctl.cursor - 1);
        return schedule();
      case "right":
        ctl.cursor = Math.min(ctl.input.length, ctl.cursor + 1);
        return schedule();
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
        if (p) p.scroll = Math.max(0, p.scroll + (name === "pageup" ? 10 : -10));
        return schedule();
      }
    }
    if (!str || key?.ctrl || key?.meta) return;
    // y / n answer a permission question when nothing is typed
    if (!ctl.input && (str === "y" || str === "n") && ctl.panes[ctl.focus]?.pending) return void ctl.answer(str === "y");
    ctl.input = ctl.input.slice(0, ctl.cursor) + str + ctl.input.slice(ctl.cursor);
    ctl.cursor += str.length;
    schedule();
  });
  process.on("SIGTERM", () => void quit());

  // ---- start ----
  hub.run();
  scheduler.start();
  setInterval(schedule, 1000).unref(); // status, unread counts
  draw();
  const saved = o.fresh ? [] : ctl.saved();
  if (saved.length) {
    ctl.say(`reopening ${saved.map((s) => s.name).join(", ")} (resuming their sessions) · /help`, 8000);
    await Promise.all(saved.map((s) => ctl.open(s)));
  } else {
    await ctl.team(o.team ?? "squad");
  }
}
