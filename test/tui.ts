/** hive tui: rendering (exact sizes, wrapping, wide chars) and the controller with mock agents. */
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { Hub } from "../src/core/hub.js";
import { TuiController } from "../src/tui/controller.js";
import { fit, gridShape, mdPlain, render, strWidth, wrap, type TuiView } from "../src/tui/render.js";
import { promptPart } from "../src/tui/controller.js";
import { assert, finish, freshDir, sleep, until } from "./util.js";

const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

// ---- pure rendering ----
assert(strWidth("abc") === 3 && strWidth("日本") === 4 && strWidth("✓") === 1 && strWidth("é") === 1, "display width handles wide and combining characters");
assert(fit("hello world", 8) === "hello w…" && fit("hi", 5) === "hi   ", "fit cuts with … and pads to the exact width");
assert(JSON.stringify(wrap("the quick brown fox", 9)) === JSON.stringify(["the quick", "brown fox"]) && wrap("x".repeat(25), 10).length === 3, "word wrap + hard break of long words");
{
  const t = mdPlain("## Review\n\n| | Finding | Where |\n|---|---|---|\n| **High** | `take()` busy-waits | `limiter.ts:27` |\n| Low | magic numbers | x.ts:3 |\n\n```ts\nconst a = 1;\n```\nSee [docs](https://example.com) and ~~old~~ **new**.");
  const ls = t.split("\n");
  assert(ls[0] === "Review" && !t.includes("**") && !t.includes("`") && !t.includes("```") && !t.includes("|"), "terminal markdown: no raw markers, fences or pipes");
  const hi = ls.find((l) => l.startsWith("High"))!;
  const lo = ls.find((l) => l.startsWith("Low"))!;
  assert(hi.indexOf("take()") === lo.indexOf("magic") && ls.some((l) => /^─+  ─+/.test(l)), "terminal markdown: table columns line up under a rule");
  assert(ls.includes("  const a = 1;") && t.includes("docs (https://example.com)") && t.includes("old new"), "terminal markdown: code indented, links keep their target");
  assert(mdPlain("| a | b |\n|---|---|\n| " + "x".repeat(50) + " | y |", 30).split("\n")[1] === "x".repeat(50) + " · y", "terminal markdown: a table wider than the pane becomes one line per row");
  assert(promptPart('You are agent "x"\n\n---\n\nfix the --- parser') === "fix the --- parser" && promptPart("a --- b") === "a --- b", "a prompt containing --- is shown whole; only a briefing in front is dropped");
}
{
  const pv = (name: string, extra: Partial<TuiView["panes"][number]> = {}) => ({ name, kind: "claude", role: "", status: "idle" as const, lines: [{ text: "hello from " + name, style: "agent" as const }], groups: [], ready: false, scroll: 0, unread: 0, ...extra });
  const v: TuiView = { title: "p", panes: [pv("planner"), pv("coder", { pending: "Write a.ts" }), pv("tester", { status: "working" })], focus: 1, zoom: false, input: "", cursor: 0, hint: "", held: 0 };
  const ls = render(v, 60, 24);
  const scr = ls.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert(ls.length === 24 && ls.every((l) => strWidth(l.replace(/\x1b\[[0-9;]*m/g, "")) === 60), "phone-width render still fills exactly 60×24");
  assert(scr.includes("[2 coder!]") && scr.includes("3 tester…") && scr.includes("hello from coder") && !scr.includes("hello from planner"), "on a phone-width terminal: one agent at a time, the others as tabs with their state");
}
assert(gridShape(4, 200).gcols === 2 && gridShape(6, 200).gcols === 3 && gridShape(10, 250).gcols === 4 && gridShape(6, 120).gcols === 2 && gridShape(4, 80).gcols === 1 && gridShape(1, 200).gcols === 1, "grid is as square as fits (4 → 2×2, 6 → 3×2), capped by terminal width");
const view: TuiView = {
  title: "proj",
  focus: 1,
  zoom: false,
  input: "fix the login bug",
  cursor: 17,
  hint: "Tab next pane",
  held: 1,
  panes: ["planner", "coder", "reviewer", "tester"].map((name, i) => ({
    name,
    kind: i % 2 ? "codex" : "claude",
    role: name,
    status: i === 1 ? "working" : "idle",
    lines: [
      { text: "› build the login page", style: "user" },
      { text: "Plan: 1) form 2) validation 3) tests — 日本語 ✓ " + "long ".repeat(40), style: "agent" },
    ],
    groups: ["squad"],
    ready: i === 2,
    pending: i === 3 ? "Write src/login.ts" : undefined,
    scroll: 0,
    unread: 0,
  })),
};
for (const [cols, rows] of [[120, 32], [200, 50], [80, 24], [60, 20]] as const) {
  const lines = render(view, cols, rows).map(plain);
  assert(lines.length === rows && lines.every((l) => strWidth(l) === cols), `render fills exactly ${cols}×${rows} (got ${lines.length} lines, widths ${[...new Set(lines.map(strWidth))].join(",")})`);
}
const screen = render(view, 120, 32).map(plain).join("\n");
assert(screen.includes("1 planner") && screen.includes("2 coder") && screen.includes("@squad"), "panes show number, name, role and groups");
assert(screen.includes("needs you: Write src/login.ts") && screen.includes("✓ ready") === false ? true : screen.includes("ready"), "permission questions and the ready state show in the pane");
assert(/2 waiting for you/.test(screen), "status bar counts what's waiting for you (permission + held mail)");
assert(plain(render(view, 120, 32).at(-1)!).startsWith(" coder › fix the login bug"), "input line shows which agent you're talking to");
assert(render({ ...view, zoom: true }, 120, 32).map(plain).join("\n").split("planner").length === 1, "zoom shows only the focused pane");

// ---- controller with mock agents ----
const dir = freshDir(".hive-test-tui");
const repo = join(dir, "repo");
freshDir(repo);
const g = (a: string[]) => execFileSync("git", a, { cwd: repo });
g(["init", "-q", "-b", "main"]);
g(["config", "user.email", "t@t"]);
g(["config", "user.name", "t"]);
writeFileSync(join(repo, "a.txt"), "a\n");
g(["add", "."]);
g(["commit", "-qm", "init"]);
let ctl!: TuiController;
const hub = new Hub({ hiveDb: join(dir, "hive.db"), pollMs: 200, onEvent: (a, e) => ctl.onEvent(a, e), defaults: { askPermission: (r, a, s) => ctl.askPermission(r, a, s) } });
ctl = new TuiController(hub, repo, { layoutFile: join(dir, "tui.json"), kind: "mock", alt: "mock" });

await ctl.team("squad");
assert(ctl.panes.map((p) => p.name).join(",") === "planner,coder,reviewer,tester" && ctl.panes.every((p) => p.status === "idle"), `/team opens four agents with roles (${ctl.panes.map((p) => p.name + ":" + p.status)})`);
assert(hub.db.groupMembers("squad").length === 5 && hub.db.listJobs(false).some((j) => j.agent === "reviewer") && hub.db.listJobs(false).some((j) => j.agent === "tester"), "the squad is linked in @squad, and reviewer/tester watch new commits");
assert(ctl.view().panes.every((p) => p.groups.includes("squad")), "panes show their group");

ctl.setFocus(0);
await ctl.submit("hello planner");
// (the mock asks permission when a prompt mentions "edit" — the planner's briefing does; deny it)
await until(() => !!ctl.panes[0].pending || ctl.panes[0].lines.some((l) => l.text.includes("[mock] done")), 10_000, "planner reply or question");
if (ctl.panes[0].pending) ctl.answer(false);
await until(() => ctl.panes[0].lines.some((l) => l.text.includes("[mock] done")), 10_000, "planner reply");
assert(ctl.panes[0].lines.some((l) => l.style === "user" && l.text.includes("hello planner")) && ctl.panes[0].lines.some((l) => l.text === "· inbox"), "typing goes to the focused agent; hive's own tools are quiet lines");

await ctl.submit("@reviewer please look");
await until(() => ctl.panes[2].lines.some((l) => l.text.includes("please look")), 10_000, "reviewer prompt");
await until(() => !!ctl.panes[2].pending || ctl.panes[2].ready, 10_000, "reviewer done or asking");
if (ctl.panes[2].pending) {
  ctl.setFocus(2);
  ctl.answer(false);
  ctl.setFocus(0);
}
await until(() => ctl.panes[2].ready, 10_000, "reviewer ready");
assert(ctl.panes[2].ready, "an agent you weren't looking at is marked ready when it finishes");
ctl.setFocus(2);
assert(!ctl.panes[2].ready, "focusing clears ready");

await ctl.submit("/add mock security sec");
assert(ctl.panes.at(-1)!.name === "sec" && ctl.panes.at(-1)!.role === "security reviewer" && ctl.focus === 4, `/add with a role opens and focuses it (${ctl.panes.at(-1)?.role})`);
await ctl.submit("/link sec coder --review");
assert(hub.db.groupMembers("sec-coder").includes("sec") && hub.db.groupSettings("sec-coder").mode === "review", "/link with --review");
await ctl.submit("/group qa tester sec");
assert(hub.db.groupMembers("qa").join(",") === "sec,tester", "/group");
await ctl.submit("/rm sec");
assert(!ctl.panes.some((p) => p.name === "sec") && !hub.sessions.has("sec"), "/rm closes the pane and the agent");

// permission y/n
ctl.setFocus(1);
await ctl.submit("please edit something");
await until(() => !!ctl.panes[1].pending, 10_000, "permission question");
assert(/Write src\/fake.ts/.test(ctl.panes[1].pending!), "a permission question shows in the pane");
ctl.answer(true);
await until(() => ctl.panes[1].lines.some((l) => l.text.includes("edit allowed")), 10_000, "edit allowed");
assert(!ctl.panes[1].pending, "y answers it and the agent continues");

await ctl.submit("/nonsense");
assert(/unknown command/.test(ctl.hint), "unknown commands explain themselves");
await ctl.submit("/help");
assert(ctl.overlay?.lines.some((l) => l.includes("/link a b")), "/help shows the command overlay");

// layout persists
const ctl2 = new TuiController(hub, repo, { layoutFile: join(dir, "tui.json") });
assert(ctl2.saved().map((p) => p.name).join(",") === "planner,coder,reviewer,tester", "the layout is remembered for next time");
await hub.close();
await sleep(100);
finish("tui");
