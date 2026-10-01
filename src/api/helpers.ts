/** Pure helpers of the API agent (api/agent.ts), split out so tests can import them. */
import { lstatSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

export type Msg =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

/**
 * Keep the request under `budget` chars: drop the oldest turns (never the system
 * prompt). The kept part starts at a user message or at an assistant message with
 * its tool calls (never an orphan tool result); if even the last such turn doesn't
 * fit, its tool results are cut short.
 */
export function fitContext(h: Msg[], budget: number): Msg[] {
  const size = (m: Msg) => JSON.stringify(m).length;
  const total = h.reduce((n, m) => n + size(m), 0);
  if (total <= budget) return h;
  const sys = h[0]?.role === "system" ? [h[0]] : [];
  const rest = h.slice(sys.length);
  const note: Msg = { role: "user", content: "(earlier conversation trimmed to fit the context window)" };
  const fixed = sys.reduce((n, m) => n + size(m), 0) + size(note);
  const starts = rest.flatMap((m, i) => (m.role === "user" || (m.role === "assistant" && m.tool_calls?.length) ? [i] : []));
  if (!starts.length) return [...sys, note];
  // Sizes of rest[i..] for each i, from the end.
  const tail: number[] = new Array(rest.length + 1).fill(0);
  for (let i = rest.length - 1; i >= 0; i--) tail[i] = tail[i + 1] + size(rest[i]);
  const first = starts.find((i) => fixed + tail[i] <= budget);
  if (first !== undefined) return [...sys, note, ...rest.slice(first)];
  // Even the last turn is too big: shorten its tool results to share what's left.
  const kept = rest.slice(starts.at(-1)!);
  const tools = kept.filter((m) => m.role === "tool").length;
  if (!tools) return [...sys, note, ...kept];
  const other = kept.filter((m) => m.role !== "tool").reduce((n, m) => n + size(m), 0);
  const each = Math.max(200, Math.floor((budget - fixed - other) / tools) - 200);
  const cut = kept.map((m) =>
    m.role === "tool" && m.content.length > each ? { ...m, content: m.content.slice(0, each) + `\n… (cut to fit the context window; ${m.content.length - each} more chars)` } : m,
  );
  return [...sys, note, ...cut];
}

/** Files under `root` (depth 3). Symlinks are listed (marked "@") but never followed; an unreadable entry is skipped. */
export function listTree(root: string, max = 400): string {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (out.length >= max || depth > 3) return;
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const n of names) {
      if (n === ".git" || n === "node_modules" || n === ".hive") continue;
      const p = join(dir, n);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      const isDir = st.isDirectory();
      out.push(relative(root, p).split(sep).join("/") + (isDir ? "/" : st.isSymbolicLink() ? "@" : ""));
      if (out.length >= max) return;
      if (isDir) walk(p, depth + 1);
    }
  };
  walk(root, 0);
  return out.join("\n") + (out.length >= max ? "\n… (truncated)" : "");
}
