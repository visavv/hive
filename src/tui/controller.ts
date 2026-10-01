/**
 * The terminal UI's brain, independent of the terminal (so it's testable):
 * keeps one pane per agent, turns session events into lines, runs commands.
 *
 *   type a message          → goes to the focused agent
 *   @name message           → to that agent (or @group)
 *   /add <agent> [role] [name]   /rm <name>   /link a b [--review]   /group <g> a b…
 *   /team [recipe]  /focus <n|name>  /zoom  /all <text>  /held /release <id> /drop <id>
 *   /verdict <prompt> --agents a,b [--text]   /usage  /scope open|linked  /help  /quit
 */
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type * as schema from "@agentclientprotocol/sdk";
import type { Hub } from "../core/hub.js";
import type { PermissionPolicy, SessionEvent } from "../core/session.js";
import { AGENTS } from "../core/agents.js";
import { ROLES } from "../core/roles.js";
import { RECIPES, applyRecipe } from "../core/recipes.js";
import { agentNameProblem } from "../core/names.js";
import { usageSummary } from "../core/budget.js";
import { runVerdict } from "../core/verdict.js";
import type { Line, PaneStatus, PaneView, TuiView } from "./render.js";

const MAX_LINES = 600;

export interface PaneSpec {
  name: string;
  kind: string;
  role?: string;
  policy?: PermissionPolicy;
  preset?: string;
  briefing?: string;
  worktree?: boolean;
}

interface Pane extends PaneView {
  spec: PaneSpec;
  toolLines: Map<string, Line>;
  resolve?: (optionId: string) => void;
  options?: schema.PermissionOption[];
}

/** Role words you can type after /add: presets, plus a few extras. */
const EXTRA_ROLES: Record<string, Omit<PaneSpec, "name" | "kind">> = {
  planner: { role: "planner / tech lead", policy: "allow-reads", briefing: RECIPES.squad.agents.find((a) => a.name === "planner")!.briefing },
  tester: { role: "tester", policy: "allow-all", worktree: true, briefing: RECIPES.squad.agents.find((a) => a.name === "tester")!.briefing },
  chat: { role: "assistant", policy: "reject-all" },
};

const HIVE_QUIET = /^(mcp__hive__)?hive_(inbox|status|agents|bb_get|bb_list|bb_set|thread)\b/;

export class TuiController extends EventEmitter {
  panes: Pane[] = [];
  focus = 0;
  zoom = false;
  input = "";
  cursor = 0;
  hint = "Tab next pane · @name message · /help";
  overlay?: { title: string; lines: string[] };
  private history: string[] = [];
  private histIdx: number | null = null;
  private hintTimer?: NodeJS.Timeout;

  constructor(
    readonly hub: Hub,
    readonly cwd: string,
    readonly opts: { layoutFile?: string; alt?: string; kind?: string } = {},
  ) {
    super();
  }

  // ---- hooks the hub calls ----

  onEvent = (agent: string, e: SessionEvent) => {
    const p = this.panes.find((x) => x.name === agent);
    if (!p) return;
    const last = p.lines.at(-1);
    switch (e.type) {
      case "prompt": {
        const auto = /^You have \d+ unread hive message/.test(e.text)
          ? "✉ " + (e.text.match(/messages?: (.*?)\. Call/)?.[1] ?? "mail").replace(/ \(.*?\)/g, "")
          : /^\[hive job #(\d+)/.test(e.text)
            ? "⏱ " + e.text.match(/^\[hive job #\d+, [^\]]+\]/)![0]
            : /^\[follow-up from/.test(e.text)
              ? "↻ " + e.text.match(/^\[follow-up from [\w.-]+\]/)![0]
              : e.text.includes("local multi-agent hive")
                ? "briefing sent"
                : undefined;
        this.push(p, auto ? { text: auto, style: "sys" } : { text: "› " + promptPart(e.text).trim(), style: "user" });
        p.status = "working";
        p.ready = false;
        break;
      }
      case "text":
        if (last?.style === "agent") last.text += e.text;
        else this.push(p, { text: e.text.replace(/^\n+/, ""), style: "agent" });
        break;
      case "tool_call": {
        const quiet = HIVE_QUIET.test(e.title);
        const send = e.title.match(/^(?:mcp__hive__)?hive_send\s*(?:→\s*(\S+))?/);
        const text = send ? `· sent mail${send[1] ? " to " + send[1] : ""}` : quiet ? "· " + e.title.replace(/^mcp__hive__/, "").replace(/^hive_/, "").replace(/_/g, " ") : `▸ ${e.title}`;
        const existing = p.toolLines.get(e.id);
        if (existing) existing.text = text;
        else {
          const l: Line = { text, style: "tool" };
          p.toolLines.set(e.id, l);
          this.push(p, l);
        }
        break;
      }
      case "tool_update": {
        const l = p.toolLines.get(e.id);
        if (l && e.status === "failed") {
          l.text += " (failed)";
          l.style = "err";
        }
        break;
      }
      case "permission":
        this.push(p, { text: `· ${e.title} → ${e.decision.replace(/_/g, " ")}`, style: "dim" });
        break;
      case "turn_end": {
        const tokens = (e.usage as any)?.totalTokens;
        this.push(p, { text: `— ${e.stopReason === "end_turn" ? "done" : e.stopReason}${tokens ? ` · ${tokens.toLocaleString()} tok` : ""}`, style: "dim" });
        p.status = "idle";
        if (this.panes[this.focus] !== p && e.stopReason !== "cancelled") p.ready = true;
        break;
      }
      case "status":
        if (e.status === "error") {
          p.status = "error";
          if (e.note) this.push(p, { text: e.note, style: "err" });
        } else if (e.status === "waiting") p.status = "waiting";
        break;
      case "notice":
        if (!String(e.text).startsWith("[stderr]")) this.push(p, { text: e.text, style: "dim" });
        break;
      case "session":
        p.toolLines.clear();
        this.push(p, { text: `session ${e.how}`, style: "dim" });
        break;
      case "exit":
        p.status = "stopped";
        this.push(p, { text: `agent process exited (${e.code})`, style: "err" });
        break;
    }
    this.changed();
  };

  /** Permission prompts become a y/n question in the agent's pane. */
  askPermission = (req: schema.RequestPermissionRequest, agent: string, signal: AbortSignal): Promise<string> => {
    const p = this.panes.find((x) => x.name === agent);
    const reject = req.options.find((o) => o.kind.startsWith("reject"))?.optionId ?? req.options[0].optionId;
    if (!p) return Promise.resolve(reject);
    return new Promise<string>((resolve) => {
      p.pending = String(req.toolCall.title ?? "permission");
      p.options = req.options;
      p.status = "waiting";
      p.resolve = (id) => {
        p.pending = undefined;
        p.resolve = undefined;
        p.status = "working";
        resolve(id);
        this.changed();
      };
      signal.addEventListener("abort", () => p.resolve?.(reject));
      this.changed();
    });
  };

  // ---- view ----

  view(): TuiView {
    const groups = this.hub.db.db.open ? this.hub.db.groups() : [];
    for (const p of this.panes) {
      p.groups = groups.filter((g) => g.members.includes(p.name)).map((g) => g.name);
      p.unread = this.hub.db.db.open ? this.hub.db.unreadCount(p.name) : 0;
    }
    return {
      title: this.cwd.split(/[\\/]/).filter(Boolean).pop() ?? this.cwd,
      panes: this.panes,
      focus: this.focus,
      zoom: this.zoom,
      input: this.input,
      cursor: this.cursor,
      hint: this.hint,
      overlay: this.overlay,
      held: this.hub.db.db.open ? this.hub.db.heldMessages().length : 0,
    };
  }

  private changed() {
    this.emit("change");
  }

  private push(p: Pane, l: Line) {
    p.lines.push(l);
    if (p.lines.length > MAX_LINES) p.lines.splice(0, p.lines.length - MAX_LINES);
  }

  say(text: string, ms = 5000) {
    this.hint = text;
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => {
      this.hint = "Tab next pane · @name message · /help";
      this.changed();
    }, ms);
    this.hintTimer.unref?.();
    this.changed();
  }

  // ---- panes ----

  async open(spec: PaneSpec): Promise<void> {
    if (this.panes.some((p) => p.name === spec.name)) throw new Error(`${spec.name} is already open`);
    const problem = agentNameProblem(spec.name);
    if (problem) throw new Error(`name: ${problem}`);
    if (!AGENTS[spec.kind]) throw new Error(`unknown agent "${spec.kind}" (${Object.keys(AGENTS).join(", ")})`);
    const pane: Pane = { name: spec.name, kind: spec.kind, role: spec.role ?? "", status: "starting", lines: [], groups: [], ready: false, scroll: 0, unread: 0, spec, toolLines: new Map() };
    this.panes.push(pane);
    this.changed();
    try {
      await this.hub.ensure({
        name: spec.name,
        agent: spec.kind,
        cwd: this.cwd,
        role: spec.role,
        policy: spec.policy ?? "ask",
        briefing: spec.briefing,
        worktree: spec.worktree,
        preset: spec.preset,
        resume: true,
      });
      if (pane.status === "starting") pane.status = "idle";
    } catch (e: any) {
      pane.status = "error";
      this.push(pane, { text: `could not start: ${e?.message ?? e}`, style: "err" });
    }
    this.save();
    this.changed();
  }

  async close(name: string, forget = false) {
    const i = this.panes.findIndex((p) => p.name === name);
    if (i < 0) throw new Error(`no pane "${name}"`);
    this.panes[i].resolve?.(this.panes[i].options?.find((o) => o.kind.startsWith("reject"))?.optionId ?? "");
    this.panes.splice(i, 1);
    this.focus = Math.min(this.focus, Math.max(0, this.panes.length - 1));
    await this.hub.remove(name, forget).catch(() => {});
    this.save();
    this.changed();
  }

  /** Set up a recipe's team (default: squad) and open every agent in it. */
  async team(id = "squad") {
    const r = RECIPES[id];
    if (!r) throw new Error(`unknown team "${id}" (${Object.keys(RECIPES).join(", ")})`);
    const kind = this.opts.kind ?? "claude";
    const alt = this.opts.alt ?? (AGENTS.codex ? "codex" : kind);
    const res = applyRecipe(this.hub.db, r, { cwd: this.cwd, kind, alt });
    await Promise.all(
      res.agents.map((a) => {
        const ra = r.agents.find((x) => x.name === a.name);
        return this.panes.some((p) => p.name === a.name)
          ? Promise.resolve()
          : this.open({ name: a.name, kind: a.kind, role: a.role, policy: a.policy as PermissionPolicy, preset: a.preset, worktree: a.worktree, briefing: ra?.briefing ?? (a.preset ? ROLES[a.preset]?.briefing : undefined) });
      }),
    );
    this.say(`${r.label}${res.groups.length ? `, linked in @${res.groups.join(" @")}` : ""}. ${r.next}`, 12000);
  }

  save() {
    if (!this.opts.layoutFile) return;
    try {
      mkdirSync(dirname(this.opts.layoutFile), { recursive: true });
      writeFileSync(this.opts.layoutFile, JSON.stringify({ panes: this.panes.map((p) => p.spec) }, null, 1));
    } catch {}
  }

  saved(): PaneSpec[] {
    try {
      return this.opts.layoutFile && existsSync(this.opts.layoutFile) ? JSON.parse(readFileSync(this.opts.layoutFile, "utf8")).panes ?? [] : [];
    } catch {
      return [];
    }
  }

  // ---- input ----

  setFocus(i: number) {
    if (!this.panes.length) return;
    this.focus = ((i % this.panes.length) + this.panes.length) % this.panes.length;
    const p = this.panes[this.focus];
    p.ready = false;
    this.changed();
  }

  /** Answer the focused pane's permission question. */
  answer(allow: boolean): boolean {
    const p = this.panes[this.focus];
    if (!p?.resolve || !p.options) return false;
    const want = allow ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
    const opt = p.options.find((o) => want.includes(o.kind)) ?? p.options[allow ? 0 : p.options.length - 1];
    p.resolve(opt.optionId);
    return true;
  }

  historyUp() {
    if (!this.history.length) return;
    this.histIdx = this.histIdx == null ? this.history.length - 1 : Math.max(0, this.histIdx - 1);
    this.input = this.history[this.histIdx];
    this.cursor = this.input.length;
    this.changed();
  }
  historyDown() {
    if (this.histIdx == null) return;
    this.histIdx++;
    if (this.histIdx >= this.history.length) {
      this.histIdx = null;
      this.input = "";
    } else this.input = this.history[this.histIdx];
    this.cursor = this.input.length;
    this.changed();
  }

  /** Enter: a command, @name message, or a prompt to the focused agent. */
  async submit(line = this.input): Promise<void> {
    const t = line.trim();
    this.input = "";
    this.cursor = 0;
    this.histIdx = null;
    if (!t) return this.changed();
    if (this.history.at(-1) !== t) this.history.push(t);
    this.overlay = undefined;
    try {
      if (t.startsWith("/")) await this.command(t);
      else if (t.startsWith("@")) await this.mail(t);
      else {
        const p = this.panes[this.focus];
        if (!p) throw new Error("no agent yet: /team, or /add claude coder");
        const s = this.hub.sessions.get(p.name);
        if (!s) throw new Error(`${p.name} isn't running (/rm ${p.name} then /add again)`);
        p.scroll = 0;
        void s.prompt(t).catch((e) => this.say(`${p.name}: ${e?.message ?? e}`));
      }
    } catch (e: any) {
      this.say(`✗ ${e?.message ?? e}`, 8000);
    }
    this.changed();
  }

  private async mail(t: string) {
    const m = t.match(/^@([\w.-]+)\s+([\s\S]+)$/);
    if (!m) throw new Error("usage: @name message  (or @group message)");
    const [, to, body] = m;
    const pane = this.panes.find((p) => p.name === to);
    if (pane && this.hub.sessions.get(to)) {
      void this.hub.sessions.get(to)!.prompt(body);
      this.say(`sent to ${to}`);
      return;
    }
    const members = this.hub.db.groupMembers(to);
    if (members.length) {
      this.hub.db.send("owner", "@" + to, body.split("\n")[0].slice(0, 80), body);
      this.say(`sent to @${to} (${members.filter((x) => x !== "owner").join(", ")})`);
      return;
    }
    if (this.hub.db.getAgent(to)) {
      this.hub.db.send("owner", to, body.split("\n")[0].slice(0, 80), body);
      this.say(`mailed ${to} (it will be woken)`);
      return;
    }
    throw new Error(`no agent or group "${to}"`);
  }

  private async command(t: string) {
    const [cmd, ...args] = t.slice(1).split(/\s+/);
    const flag = (f: string) => {
      const i = args.indexOf(f);
      if (i < 0) return undefined;
      const v = args[i + 1];
      args.splice(i, 2);
      return v ?? "";
    };
    const bool = (f: string) => {
      const i = args.indexOf(f);
      if (i < 0) return false;
      args.splice(i, 1);
      return true;
    };
    // /1 … /9: jump to an agent (phones have no Alt key)
    if (/^[1-9]$/.test(cmd)) return this.setFocus(Number(cmd) - 1);
    switch (cmd) {
      case "help":
      case "?":
        this.overlay = { title: "hive tui: commands (Esc closes)", lines: HELP };
        return;
      case "q":
      case "quit":
      case "exit":
        this.emit("quit");
        return;
      case "add": {
        // /add <agent> [role] [name]  e.g. /add codex reviewer   /add claude coder c2
        const kind = args[0];
        if (!kind) throw new Error(`usage: /add <agent> [role] [name] · agents: ${Object.keys(AGENTS).filter((k) => k !== "mock").join(", ")} · roles: ${[...Object.keys(ROLES), ...Object.keys(EXTRA_ROLES)].join(", ")}`);
        const roleWord = args[1] && (ROLES[args[1]] || EXTRA_ROLES[args[1]]) ? args[1] : undefined;
        let name = (roleWord ? args[2] : args[1]) ?? roleWord ?? kind;
        if (!args[roleWord ? 2 : 1]) {
          let n = 2;
          const base = name;
          while (this.panes.some((p) => p.name === name) || this.hub.db.getAgent(name)?.owner) name = `${base}-${n++}`;
        }
        const preset = roleWord && ROLES[roleWord] ? ROLES[roleWord] : undefined;
        const extra = roleWord ? EXTRA_ROLES[roleWord] : undefined;
        await this.open({
          name,
          kind,
          role: preset?.role ?? extra?.role,
          policy: (preset?.policy ?? extra?.policy ?? "ask") as PermissionPolicy,
          preset: preset?.id,
          briefing: preset?.briefing ?? extra?.briefing,
          worktree: preset?.worktree ?? extra?.worktree,
        });
        this.setFocus(this.panes.findIndex((p) => p.name === name));
        this.say(`added ${name} (${kind}${roleWord ? ", " + roleWord : ""})`);
        return;
      }
      case "rm":
      case "close": {
        const name = args[0] ?? this.panes[this.focus]?.name;
        if (!name) throw new Error("usage: /rm <name>");
        await this.close(name, bool("--forget"));
        this.say(`closed ${name}`);
        return;
      }
      case "team":
        await this.team(args[0]);
        return;
      case "link": {
        const review = bool("--review");
        const name = flag("--name");
        const members = args.filter(Boolean);
        if (members.length < 2) throw new Error("usage: /link a b [c…] [--review] [--name group]");
        for (const m of members) if (!this.hub.db.getAgent(m)) throw new Error(`no agent "${m}"`);
        const g = (name || members.join("-")).slice(0, 40);
        this.hub.db.addToGroup(g, [...members, "owner"]);
        if (review) this.hub.db.setGroupSettings(g, { mode: "review" });
        this.say(`linked @${g}: ${members.join(", ")}${review ? " (you review each message: /held)" : ""}`);
        return;
      }
      case "unlink": {
        const g = args[0];
        if (!g) throw new Error("usage: /unlink <group>");
        this.hub.db.deleteGroup(g.replace(/^@/, ""));
        this.say(`removed @${g.replace(/^@/, "")}`);
        return;
      }
      case "group": {
        const [g, ...members] = args;
        if (!g || !members.length) throw new Error("usage: /group <name> <agent> [agent…]");
        for (const m of members) if (m !== "owner" && !this.hub.db.getAgent(m)) throw new Error(`no agent "${m}"`);
        this.hub.db.addToGroup(g.replace(/^@/, ""), members);
        this.say(`@${g.replace(/^@/, "")}: ${this.hub.db.groupMembers(g.replace(/^@/, "")).join(", ")}`);
        return;
      }
      case "groups":
        this.overlay = {
          title: "Groups (Esc closes)",
          lines: this.hub.db.groups().map((g) => {
            const st = this.hub.db.groupSettings(g.name);
            return `@${g.name}: ${g.members.join(", ")}  (${st.mode}${st.max_per_hour ? `, max ${st.max_per_hour}/h` : ""})`;
          }),
        };
        if (!this.overlay.lines.length) this.overlay.lines.push("none yet: /link a b");
        return;
      case "scope": {
        if (args[0] !== "open" && args[0] !== "linked") throw new Error("usage: /scope open|linked");
        this.hub.db.setMailScope(args[0]);
        this.say(args[0] === "linked" ? "agents only talk to agents they're linked with" : "agents can message anyone");
        return;
      }
      case "focus": {
        const a = args[0];
        const i = /^\d+$/.test(a ?? "") ? Number(a) - 1 : this.panes.findIndex((p) => p.name === a);
        if (i < 0 || i >= this.panes.length) throw new Error("usage: /focus <number|name>");
        this.setFocus(i);
        return;
      }
      case "zoom":
        this.zoom = !this.zoom;
        return;
      case "all": {
        const text = args.join(" ");
        if (!text) throw new Error("usage: /all <message>");
        for (const p of this.panes) void this.hub.sessions.get(p.name)?.prompt(text);
        this.say(`sent to ${this.panes.length} agents`);
        return;
      }
      case "cancel":
      case "stop":
        await this.hub.sessions.get(args[0] ?? this.panes[this.focus]?.name)?.cancel();
        return;
      case "held": {
        const rows = this.hub.db.heldMessages();
        this.overlay = {
          title: "Waiting for your review (Esc closes) · /release <id> · /drop <id>",
          lines: rows.length ? rows.flatMap((m) => [`#${m.id}  ${m.from_agent} → ${m.to_agent}: ${m.subject}`, `      ${m.body.slice(0, 300)}`, `      ${m.held}`, ""]) : ["nothing waiting"],
        };
        return;
      }
      case "release":
      case "drop": {
        const id = Number(args[0]);
        const ok = cmd === "release" ? this.hub.db.releaseMessage(id) : this.hub.db.dropMessage(id);
        if (!ok) throw new Error(`#${args[0]} isn't waiting (see /held)`);
        this.say(`${cmd === "release" ? "released" : "dropped"} #${id}`);
        return;
      }
      case "usage": {
        const u = usageSummary(this.hub.db);
        this.overlay = {
          title: "Usage (Esc closes)",
          lines: u.providers.length
            ? u.providers.flatMap((p) => [
                `${p.provider}: 5h ${p.h5.toLocaleString()} · today ${p.d1.toLocaleString()} · 7d ${p.d7.toLocaleString()} tokens`,
                ...p.limits.map((l) => `   ${l.window}: ${l.pct != null ? `${Math.max(0, 100 - Math.round(l.pct))}% left` : l.status}${l.resetsAt ? `, resets ${new Date(l.resetsAt).toLocaleTimeString()}` : ""}`),
                ...(p.guard.ok ? [] : [`   automatic work held: ${p.guard.reason}`]),
              ])
            : ["no usage yet"],
        };
        return;
      }
      case "verdict": {
        const agents = flag("--agents");
        const judge = flag("--judge") ?? this.opts.kind ?? "claude";
        const text = bool("--text");
        const prompt = args.join(" ").replace(/^"|"$/g, "");
        if (!agents || !prompt) throw new Error('usage: /verdict <prompt> --agents claude,codex [--judge claude] [--text]');
        this.say(`verdict started: ${agents.split(",").length} agents + judge ${judge}…`, 15000);
        void runVerdict(this.hub, { prompt, kinds: agents.split(","), judge, mode: text ? "text" : "code", cwd: this.cwd })
          .then((v) => {
            this.overlay = { title: `Verdict #${v.id}: ${v.status} (Esc closes) · hive verdict apply ${v.id}`, lines: (v.verdict ?? v.error ?? "").split("\n") };
            this.changed();
          })
          .catch((e) => this.say(`verdict: ${e?.message ?? e}`, 10000));
        return;
      }
      default:
        throw new Error(`unknown command /${cmd} (try /help)`);
    }
  }
}

const HELP = [
  "Type a message and press Enter: it goes to the focused agent (highlighted border).",
  "@name message        message one agent, or @group message for a whole group",
  "Tab / Shift+Tab      next / previous pane      Alt+1..9  jump to pane",
  "PgUp / PgDn          scroll the focused pane   Esc       cancel the focused agent's turn",
  "y / n                answer a permission question (with an empty prompt)",
  "",
  "/team [squad|review-loop|solid-code|…]   open a ready-made team (default: planner, coder, reviewer, tester)",
  "/add <agent> [role] [name]   e.g. /add codex reviewer · /add claude coder c2 · roles: coder reviewer security scout bughunter planner tester chat",
  "/rm [name]                   close a pane (add --forget to remove the agent)",
  "/link a b [--review]         let agents talk; --review: you approve each message (/held, /release, /drop)",
  "/group <name> a b …          a group: @name reaches all members · /groups · /unlink <group>",
  "/scope open|linked           linked: agents only talk to agents they're linked with",
  "/1 … /9 or /focus <n|name> · /zoom · /all <msg> · /stop [name]",
  "/verdict <prompt> --agents claude,codex [--text]   several agents, one judge",
  "/usage · /help · /quit",
];

/** The prompt you typed, without a briefing hive put in front of it ("<briefing>\n\n---\n\n<prompt>"). */
export function promptPart(text: string): string {
  const sep = text.lastIndexOf("\n\n---\n\n");
  return sep >= 0 && /You are agent "/.test(text.slice(0, sep)) ? text.slice(sep + 7) : text;
}
