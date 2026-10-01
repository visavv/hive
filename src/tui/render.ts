/**
 * Terminal rendering for `hive tui`: pure functions from state to lines, so the
 * layout is testable without a terminal. Styling follows the desktop app:
 * calm grays, one accent for "needs you", green for "ready".
 */

export type LineStyle = "user" | "agent" | "dim" | "tool" | "warn" | "err" | "ok" | "sys";
export interface Line {
  text: string;
  style: LineStyle;
}
export type PaneStatus = "starting" | "idle" | "working" | "waiting" | "error" | "stopped";

export interface PaneView {
  name: string;
  kind: string;
  role: string;
  status: PaneStatus;
  lines: Line[];
  groups: string[];
  ready: boolean; // finished while you weren't looking
  pending?: string; // permission question waiting for y/n
  scroll: number; // lines scrolled up from the bottom
  unread: number;
}

export interface TuiView {
  title: string;
  panes: PaneView[];
  focus: number;
  zoom: boolean;
  input: string;
  cursor: number;
  hint: string;
  overlay?: { title: string; lines: string[] };
  held: number;
}

const ESC = "\x1b[";
const reset = `${ESC}0m`;
const c = {
  dim: `${ESC}38;5;245m`,
  faint: `${ESC}38;5;240m`,
  fg: `${ESC}38;5;252m`,
  bright: `${ESC}38;5;255m`,
  accent: `${ESC}38;5;179m`,
  green: `${ESC}38;5;78m`,
  red: `${ESC}38;5;167m`,
  blue: `${ESC}38;5;110m`,
  bold: `${ESC}1m`,
  barBg: `${ESC}48;5;235m`,
  inv: `${ESC}7m`,
};
const STYLE: Record<LineStyle, string> = {
  user: c.blue,
  agent: c.fg,
  dim: c.dim,
  tool: c.faint,
  warn: c.accent,
  err: c.red,
  ok: c.green,
  sys: c.dim,
};

/** Display width of a string: wide (CJK, emoji) = 2, combining marks = 0. */
export function strWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 32 || (cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) continue;
    w +=
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0x1f300 && cp <= 0x1faff)
        ? 2
        : 1;
  }
  return w;
}

/** Cut to `width` columns (with …) and pad with spaces to exactly `width`. */
export function fit(s: string, width: number): string {
  if (width <= 0) return "";
  let out = "";
  let w = 0;
  const full = strWidth(s) > width;
  const limit = full ? width - 1 : width;
  for (const ch of s) {
    const cw = strWidth(ch);
    if (w + cw > limit) break;
    out += ch;
    w += cw;
  }
  if (full) {
    out += "…";
    w += 1;
  }
  return out + " ".repeat(Math.max(0, width - w));
}

/** Word-wrap one logical line to `width` columns. */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [];
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (!para) {
      out.push("");
      continue;
    }
    let line = "";
    let lw = 0;
    for (const word of para.split(/(\s+)/)) {
      const ww = strWidth(word);
      if (lw + ww <= width) {
        line += word;
        lw += ww;
        continue;
      }
      if (line.trim()) out.push(line.trimEnd());
      if (ww > width) {
        // a very long word: hard-break it
        let chunk = "";
        let cw = 0;
        for (const ch of word) {
          const w = strWidth(ch);
          if (cw + w > width) {
            out.push(chunk);
            chunk = "";
            cw = 0;
          }
          chunk += ch;
          cw += w;
        }
        line = chunk;
        lw = cw;
      } else {
        line = /^\s+$/.test(word) ? "" : word;
        lw = /^\s+$/.test(word) ? 0 : ww;
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

/**
 * Markdown to plain terminal text: tables as aligned columns, code fences dropped
 * (code indented), emphasis / inline-code markers and link targets removed.
 */
export function mdPlain(md: string, width = Infinity): string {
  const out: string[] = [];
  const lines = md.split("\n");
  const inline = (t: string) =>
    t
      .replace(/\*\*(.+?)\*\*|__(.+?)__/g, "$1$2")
      .replace(/~~(.+?)~~/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, (_m, txt, url) => (txt && txt !== url ? `${txt} (${url})` : url));
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*```/.test(l)) {
      fence = !fence;
      continue;
    }
    if (fence) {
      out.push("  " + l);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(l)) {
      // a table: collect its rows, then pad columns
      const rows: string[][] = [];
      let j = i;
      for (; j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j]); j++) {
        const cells = lines[j].trim().slice(1, -1).split("|").map((c) => inline(c.trim()));
        rows.push(cells);
      }
      i = j - 1;
      const isRule = (r: string[]) => r.every((c) => /^:?-{2,}:?$/.test(c) || c === "");
      const body = rows.filter((r) => !isRule(r));
      const w: number[] = [];
      for (const r of body) r.forEach((c, k) => (w[k] = Math.max(w[k] ?? 0, strWidth(c))));
      const total = w.reduce((a, n) => a + n, 0) + 2 * Math.max(0, w.length - 1);
      if (total > width) {
        // too wide for the pane: one line per row, header first
        for (const r of body) out.push(r.filter(Boolean).join(" · "));
        continue;
      }
      body.forEach((r, k) => {
        out.push(r.map((c, n) => c + " ".repeat(Math.max(0, w[n] - strWidth(c)))).join("  ").trimEnd());
        if (k === 0 && rows.length > 1 && isRule(rows[1])) out.push(w.map((n) => "─".repeat(n)).join("  "));
      });
      continue;
    }
    out.push(inline(l.replace(/^#{1,6}\s+/, "")));
  }
  return out.join("\n");
}

// agent text is re-rendered every frame; convert each message once per change
const plainCache = new WeakMap<Line, { src: string; width: number; out: string }>();
function plainOf(l: Line, width: number): string {
  const c = plainCache.get(l);
  if (c && c.src === l.text && c.width === width) return c.out;
  const out = mdPlain(l.text, width);
  plainCache.set(l, { src: l.text, width, out });
  return out;
}

const DOT: Record<PaneStatus, [string, string]> = {
  starting: ["◌", c.blue],
  idle: ["●", c.green],
  working: ["●", c.accent],
  waiting: ["●", c.accent],
  error: ["●", c.red],
  stopped: ["○", c.faint],
};

export function gridShape(n: number, cols: number): { gcols: number; grows: number } {
  if (n <= 1) return { gcols: 1, grows: 1 };
  // As square as possible (4 → 2×2, 6 → 3×2), capped by what fits the terminal width.
  const maxCols = cols >= 210 ? 4 : cols >= 150 ? 3 : cols >= 90 ? 2 : 1;
  const gcols = Math.max(1, Math.min(maxCols, Math.ceil(Math.sqrt(n)), n));
  return { gcols, grows: Math.ceil(n / gcols) };
}

function paneBox(p: PaneView, idx: number, focused: boolean, w: number, h: number): string[] {
  const inner = w - 2;
  const border = focused ? c.accent : c.faint;
  const [dot, dotColor] = p.pending ? ["●", c.accent] : p.ready ? ["✓", c.green] : DOT[p.status];
  const groups = p.groups.length ? `  ${p.groups.map((g) => "@" + g).join(" ")}` : "";
  const label = ` ${idx + 1} ${p.name} `;
  const meta = ` ${p.kind}${p.role ? " · " + p.role : ""}${groups}${p.unread ? ` · ${p.unread} mail` : ""} `;
  const statusText = p.pending ? " needs you " : p.ready ? " ready " : ` ${p.status} `;
  // top border: ┌ 1 coder ─ claude · coder ──── ● working ┐
  const fixed = strWidth(label) + strWidth(statusText) + 2 + 2;
  const metaFit = fit(meta, Math.max(0, Math.min(strWidth(meta), inner - fixed + 2)));
  const used = strWidth(label) + strWidth(metaFit) + strWidth(statusText) + 2;
  const fill = Math.max(0, inner - used);
  const top =
    `${border}┌${reset}${focused ? c.bright + c.bold : c.fg}${fit(label, Math.min(strWidth(label), inner))}${reset}` +
    `${c.dim}${metaFit}${reset}${border}${"─".repeat(fill)}${reset}${dotColor}${dot}${reset}${c.dim}${statusText}${reset}${border}─┐${reset}`;
  const bodyH = Math.max(0, h - 2);
  const wrapped: { text: string; style: LineStyle }[] = [];
  for (const l of p.lines) for (const t of wrap(l.style === "agent" ? plainOf(l, inner - 1) : l.text, inner - 1)) wrapped.push({ text: t, style: l.style });
  if (p.pending) {
    wrapped.push({ text: "", style: "dim" });
    for (const t of wrap(`needs you: ${p.pending}`, inner - 1)) wrapped.push({ text: t, style: "warn" });
    wrapped.push({ text: "y = allow · n = deny (with an empty prompt)", style: "warn" });
  }
  const end = Math.max(0, wrapped.length - p.scroll);
  const shown = wrapped.slice(Math.max(0, end - bodyH), end);
  const body: string[] = [];
  for (let i = 0; i < bodyH; i++) {
    // top-aligned like a terminal; once it overflows, the newest lines stay visible
    const l = shown[i];
    const text = l ? " " + fit(l.text, inner - 1) : " ".repeat(inner);
    body.push(`${border}│${reset}${l ? STYLE[l.style] : ""}${text}${reset}${border}│${reset}`);
  }
  if (p.scroll > 0 && body.length) {
    const tag = ` ↑${p.scroll} `;
    body[body.length - 1] = `${border}│${reset}${" ".repeat(Math.max(0, inner - tag.length))}${c.inv}${tag}${reset}${border}│${reset}`;
  }
  const bottom = `${border}└${"─".repeat(inner)}┘${reset}`;
  return [top, ...body, bottom];
}

/** Render the whole screen: exactly `rows` lines, each exactly `cols` wide. */
export function render(v: TuiView, cols: number, rows: number): string[] {
  const out: string[] = [];
  // status bar
  const working = v.panes.filter((p) => p.status === "working").length;
  const ready = v.panes.filter((p) => p.ready).length;
  const needs = v.panes.filter((p) => p.pending).length + v.held;
  const right = [working && `${working} working`, ready && `✓ ${ready} ready`, needs && `${needs} waiting for you`].filter(Boolean).join("  ·  ");
  const left = ` hive  ${v.title}  ·  ${v.panes.length} agent${v.panes.length === 1 ? "" : "s"}`;
  const bar = fit(left, Math.max(0, cols - strWidth(right) - 1)) + right + " ";
  out.push(`${c.barBg}${c.fg}${fit(bar, cols)}${reset}`);
  // Narrow terminals (a phone over SSH): one agent at a time, the others as tabs.
  const narrow = cols < 90 && v.panes.length > 1 && !v.overlay;
  if (narrow) {
    const tabs = v.panes.map((p, i) => {
      const mark = p.pending ? "!" : p.ready ? "✓" : p.status === "working" ? "…" : p.status === "error" ? "✗" : "";
      return i === v.focus ? `[${i + 1} ${p.name}${mark}]` : ` ${i + 1} ${p.name}${mark} `;
    });
    out.push(`${c.dim}${fit(tabs.join(""), cols)}${reset}`);
  }
  const areaH = Math.max(0, rows - 3 - (narrow ? 1 : 0));
  if (v.overlay) {
    const w = Math.min(cols, 100);
    const pad = " ".repeat(Math.max(0, Math.floor((cols - w) / 2)));
    const lines = [`${c.bold}${v.overlay.title}${reset}`, "", ...v.overlay.lines.flatMap((l) => wrap(l, w - 4))];
    for (let i = 0; i < areaH; i++) {
      const l = lines[i];
      out.push(l === undefined ? " ".repeat(cols) : pad + fit("  " + l.replace(/\x1b\[[0-9;]*m/g, ""), cols - pad.length));
    }
  } else if (!v.panes.length) {
    for (let i = 0; i < areaH; i++)
      out.push(i === Math.floor(areaH / 2) ? fit(" ".repeat(Math.max(0, Math.floor((cols - 44) / 2))) + "No agents. Try /add claude coder or /team", cols) : " ".repeat(cols));
  } else {
    const shown = v.zoom || narrow ? [v.focus] : v.panes.map((_, i) => i);
    const { gcols, grows } = gridShape(shown.length, cols);
    const baseW = Math.floor(cols / gcols);
    const baseH = Math.floor(areaH / grows);
    for (let r = 0; r < grows; r++) {
      const h = r === grows - 1 ? areaH - baseH * (grows - 1) : baseH;
      const rowBoxes: string[][] = [];
      for (let col = 0; col < gcols; col++) {
        const w = col === gcols - 1 ? cols - baseW * (gcols - 1) : baseW;
        const idx = shown[r * gcols + col];
        rowBoxes.push(idx === undefined ? Array(h).fill(" ".repeat(w)) : paneBox(v.panes[idx], idx, idx === v.focus, w, h));
      }
      for (let i = 0; i < h; i++) out.push(rowBoxes.map((b) => b[i] ?? "").join(""));
    }
  }
  // hint line + input line
  out.push(`${c.dim}${fit(" " + v.hint, cols)}${reset}`);
  const target = v.panes[v.focus]?.name ?? "hive";
  const promptLabel = v.input.startsWith("/") ? " command › " : ` ${target} › `;
  const avail = cols - strWidth(promptLabel);
  const shownInput = strWidth(v.input) > avail - 1 ? "…" + v.input.slice(-(avail - 2)) : v.input;
  out.push(`${c.accent}${promptLabel}${reset}${fit(shownInput, avail)}`);
  return out.slice(0, rows);
}

/** Column of the input cursor (0-based) on the last line. */
export function cursorColumn(v: TuiView, cols: number): number {
  const target = v.panes[v.focus]?.name ?? "hive";
  const promptLabel = v.input.startsWith("/") ? " command › " : ` ${target} › `;
  return Math.min(cols - 1, strWidth(promptLabel) + strWidth(v.input.slice(0, v.cursor)));
}
