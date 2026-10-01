/**
 * Renderer state: per-pane transcript items built from SessionEvents, plus
 * the agent/job lists and pending permission/elicitation asks. A tiny
 * external store (useSyncExternalStore) so streaming chunks don't re-render
 * every pane.
 */
import { useSyncExternalStore } from "react";
import { focus } from "./focus.js";
import type { AgentView, BackendEvent, ElicitationAsk, JobView, Layout, OtherAgent, PermissionAsk, PresetView } from "../protocol.js";

/** Every item has a stable id (React key) and a rev bumped on each mutation (memo key). */
export type Item = ItemBody & { id: number; rev: number };
type ItemBody =
  | { k: "user"; text: string; ts: number }
  | { k: "agent"; text: string }
  | { k: "thought"; text: string }
  | { k: "tool"; toolId: string; title: string; kind?: string; status: string; content: any[]; locations: any[]; rawInput?: unknown }
  | { k: "plan"; entries: { content: string; status: string; priority?: string }[] }
  | { k: "permission"; ask: PermissionAsk; decided?: string }
  | { k: "elicitation"; ask: ElicitationAsk; done?: string }
  | { k: "notice"; text: string; level?: "info" | "error" }
  | { k: "turn"; stopReason: string; tokens?: number; ts: number }
  | { k: "session"; how: string; sessionId: string };

export interface PaneState {
  items: Item[];
  version: number;
  /** Items keyed by tool id for in-place updates (cleared per ACP session). */
  tools: Map<string, Item & { k: "tool" }>;
  history: string[];
  loadedHistory: boolean;
}

const MAX_ITEMS = 1500;
const MAX_TOOL_TEXT = 100_000;
let nextItemId = 1;

/** Keep tool output bounded in memory. */
function capContent(content: any[]): any[] {
  return content.map((c) =>
    c?.type === "content" && c.content?.type === "text" && c.content.text.length > MAX_TOOL_TEXT
      ? { ...c, content: { ...c.content, text: c.content.text.slice(-MAX_TOOL_TEXT) } }
      : c,
  );
}

class Store {
  panes = new Map<string, PaneState>();
  agents = new Map<string, AgentView>();
  others: OtherAgent[] = [];
  starting = new Map<string, { kind: string; error?: string }>();
  jobs: JobView[] = [];
  kinds: import("../protocol.js").KindView[] = [];
  presets: PresetView[] = [];
  /** Unread mail agents sent to the owner. */
  ownerUnread = 0;
  cwd = "";
  db = "";
  layout: Layout = { panes: [], columns: 2, hoverFocus: true, sidebar: true, maximized: null };
  ready = false;
  /** Panes whose agent finished a turn you haven't looked at yet (green until focused). */
  readyAt = new Map<string, number>();
  private turnStart = new Map<string, { at: number; mail: boolean }>();
  toasts: { id: number; text: string; level: "info" | "error" }[] = [];
  version = 0;
  private subs = new Set<() => void>();
  private toastId = 0;

  subscribe = (fn: () => void) => {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  };
  private scheduled = false;
  /** Coalesce bursts of streaming chunks into one render per frame. */
  bump() {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      for (const s of this.subs) s();
    });
  }

  /** A non-transcript change (agents, layout, toasts…): re-render global views. */
  changed() {
    this.version++;
    this.bump();
  }

  pane(name: string): PaneState {
    let p = this.panes.get(name);
    if (!p) {
      p = { items: [], version: 0, tools: new Map(), history: [], loadedHistory: false };
      this.panes.set(name, p);
    }
    return p;
  }

  push(name: string, body: ItemBody): Item {
    const p = this.pane(name);
    const item = { ...body, id: nextItemId++, rev: 0 } as Item;
    p.items.push(item);
    if (p.items.length > MAX_ITEMS) {
      const dropped = p.items.splice(0, p.items.length - MAX_ITEMS);
      for (const d of dropped) if (d.k === "tool") p.tools.delete(d.toolId);
    }
    p.version++;
    return item;
  }

  /** Mark an item changed so its memoized view re-renders. */
  touch(name: string, item: Item) {
    item.rev++;
    this.pane(name).version++;
  }

  toast(text: string, level: "info" | "error" = "info") {
    // Same message already showing: don't stack duplicates; keep at most three.
    if (this.toasts.some((t) => t.text === text)) return;
    if (this.toasts.length >= 3) this.toasts.shift();
    const id = ++this.toastId;
    this.toasts.push({ id, text, level });
    setTimeout(() => {
      this.toasts = this.toasts.filter((t) => t.id !== id);
      this.changed();
    }, level === "error" ? 8000 : 4000);
    this.changed();
  }

  /** Open the Skills dialog on a skill with some values filled in. */
  skillRequest: { name: string; vals: Record<string, string> } | null = null;
  groups: import("../protocol.js").GroupView[] = [];
  /** Latest state of verdict rounds, by id (live progress). */
  verdicts = new Map<number, import("../../core/verdict.js").VerdictState>();
  /** Verdict window: "new" = setup dialog (optional prompt), or a round id to watch. */
  verdictOpen: { prompt?: string } | number | null = null;
  openVerdict(v: { prompt?: string } | number | null) {
    this.verdictOpen = v;
    this.changed();
  }
  mailScope: "open" | "linked" = "open";
  /** Link dialog open with these agents preselected. */
  linkRequest: string[] | null = null;
  /** Group chat open for this group. */
  groupOpen: string | null = null;
  /** Messages waiting for your review (any group, or guarded mail to allow-all agents). */
  heldTotal = 0;
  private heldSeen = -1;
  guardAllowAll = true;
  requestLink(members: string[]) {
    this.linkRequest = members;
    this.changed();
  }
  openGroup(name: string | null) {
    this.groupOpen = name;
    this.changed();
  }
  requestSkill(name: string, vals: Record<string, string>) {
    this.skillRequest = { name, vals };
    this.changed();
  }

  /** You looked at the pane (focus, click, typing): it's no longer "ready". */
  clearReady(name: string) {
    if (this.readyAt.delete(name)) this.changed();
  }

  /** A turn ended: mark the pane ready unless you're looking at it, ping, notify. */
  private turnEnded(name: string, stopReason: string) {
    const t = this.turnStart.get(name) ?? { at: Date.now(), mail: false };
    this.turnStart.delete(name);
    if (stopReason === "cancelled") return;
    const watching = document.hasFocus() && focus.active === name;
    if (watching) return;
    this.readyAt.set(name, Date.now());
    // Agents answering each other's mail get the green mark but no chime (that would never stop).
    const long = Date.now() - t.at >= 4000;
    if (this.layout.ping !== false && !t.mail && (long || !document.hasFocus())) ping();
    if (!document.hasFocus()) {
      const p = this.panes.get(name);
      const last = [...(p?.items ?? [])].reverse().find((i) => i.k === "agent") as { text: string } | undefined;
      notifyAttention(name, last?.text ?? "finished", "is ready");
    }
  }

  /** Items that need the user (for the sidebar badge and title). */
  waitingOn(name: string): number {
    const p = this.panes.get(name);
    if (!p) return 0;
    return p.items.filter((i) => (i.k === "permission" && !i.decided) || (i.k === "elicitation" && !i.done)).length;
  }

  apply(ev: BackendEvent) {
    // Transcript updates only bump their pane's version, so streaming text
    // re-renders that pane alone; everything else bumps the global version.
    let global = true;
    switch (ev.event) {
      case "ready":
        break; // App fetches the full state (getState) on ready
      case "agents": {
        this.agents = new Map(ev.agents.map((a) => [a.name, a]));
        this.others = ev.others ?? [];
        if (ev.groups) this.groups = ev.groups;
        if (ev.heldTotal !== undefined) {
          if (this.heldSeen >= 0 && ev.heldTotal > this.heldSeen) {
            this.toast("Waiting for you: an agent message needs your review (Hive → Inbox)");
            notifyAttention("hive", "an agent message is waiting for your review", "needs you");
          }
          this.heldSeen = ev.heldTotal;
          this.heldTotal = ev.heldTotal;
        }
        if (ev.guardAllowAll !== undefined) this.guardAllowAll = ev.guardAllowAll;
        if (ev.mailScope) this.mailScope = ev.mailScope;
        break;
      }
      case "jobs":
        this.jobs = ev.jobs;
        break;
      case "job":
        if (this.hasPane(ev.agent)) this.push(ev.agent, { k: "notice", text: ev.text });
        break;
      case "error":
        this.toast(ev.text, "error");
        break;
      case "permission":
        this.addAsk(ev.ask.agent, { k: "permission", ask: ev.ask });
        notifyAttention(ev.ask.agent, ev.ask.title);
        break;
      case "permission_done":
        for (const [name, p] of this.panes)
          for (const i of p.items)
            if (i.k === "permission" && i.ask.reqId === ev.reqId && !i.decided) {
              i.decided = ev.outcome ?? "answered";
              this.touch(name, i);
            }
        break;
      case "elicitation":
        this.addAsk(ev.ask.agent, { k: "elicitation", ask: ev.ask });
        notifyAttention(ev.ask.agent, ev.ask.message);
        break;
      case "elicitation_done":
        for (const [name, p] of this.panes)
          for (const i of p.items)
            if (i.k === "elicitation" && i.ask.reqId === ev.reqId && !i.done) {
              i.done = ev.outcome ?? "answered";
              this.touch(name, i);
            }
        break;
      case "verdict": {
        const prev = this.verdicts.get(ev.state.id);
        this.verdicts.set(ev.state.id, ev.state);
        if (prev && prev.status !== ev.state.status && (ev.state.status === "done" || ev.state.status === "applied" || ev.state.status === "failed")) {
          this.toast(`Verdict #${ev.state.id} ${ev.state.status === "failed" ? `failed: ${ev.state.error ?? ""}` : ev.state.status === "applied" ? "built" : "ready"}`, ev.state.status === "failed" ? "error" : "info");
          if (this.layout.ping !== false) ping();
          notifyAttention(`verdict #${ev.state.id}`, ev.state.status, "is ready");
        }
        break;
      }
      case "owner_mail":
        this.ownerUnread = ev.unread;
        if (ev.latest) {
          this.toast(`✉ ${ev.latest.from}: ${ev.latest.subject}`);
          notifyAttention(ev.latest.from, ev.latest.subject, "wrote to you");
        }
        break;
      case "backend_down":
        this.toast(ev.text, "error");
        // The requests behind open cards died with the backend.
        for (const [name, p] of this.panes)
          for (const i of p.items) {
            if (i.k === "permission" && !i.decided) {
              i.decided = "void (backend restarted)";
              this.touch(name, i);
            }
            if (i.k === "elicitation" && !i.done) {
              i.done = "void (backend restarted)";
              this.touch(name, i);
            }
          }
        break;
      case "agent":
        global = this.applyAgent(ev.agent, ev.e as any);
        break;
    }
    if (global) this.version++;
    this.bump();
  }

  /** Add a permission/question card unless it's already shown (resync). */
  addAsk(name: string, body: ItemBody & { k: "permission" | "elicitation" }) {
    const p = this.pane(name);
    if (p.items.some((i) => (i.k === "permission" || i.k === "elicitation") && i.ask.reqId === body.ask.reqId)) return;
    this.push(name, body);
  }

  /** An agent shown in a pane (or one being opened). Others — verdict contenders and judges, headless job agents, closed panes — keep no transcript here. */
  hasPane(name: string): boolean {
    return this.layout.panes.some((p) => p.name === name);
  }

  /** Returns true when the change matters beyond this pane's transcript. */
  private applyAgent(name: string, e: any): boolean {
    if (!this.hasPane(name)) {
      this.turnStart.delete(name);
      return e.type === "status" || e.type === "exit" || e.type === "turn_end";
    }
    const p = this.pane(name);
    const last = p.items[p.items.length - 1];
    switch (e.type) {
      case "prompt":
        this.push(name, { k: "user", text: e.text, ts: Date.now() });
        if (!e.queued) this.turnStart.set(name, { at: Date.now(), mail: String(e.text).startsWith("You have ") });
        return this.readyAt.delete(name);
      case "text":
        if (last?.k === "agent") {
          last.text += e.text;
          this.touch(name, last);
        } else this.push(name, { k: "agent", text: e.text });
        return false;
      case "thought":
        if (last?.k === "thought") {
          last.text += e.text;
          this.touch(name, last);
        } else this.push(name, { k: "thought", text: e.text });
        return false;
      case "tool_call": {
        const raw = e.raw ?? {};
        // Some agents re-send tool_call (not tool_call_update) for the same id.
        const existing = p.tools.get(e.id);
        if (existing) {
          existing.status = e.status ?? existing.status;
          existing.title = e.title ?? existing.title;
          if (raw.content) existing.content = capContent(raw.content);
          if (raw.locations) existing.locations = raw.locations;
          this.touch(name, existing);
          return false;
        }
        const item = this.push(name, {
          k: "tool",
          toolId: e.id,
          title: e.title,
          kind: e.kind,
          status: e.status,
          content: capContent(raw.content ?? []),
          locations: raw.locations ?? [],
          rawInput: raw.rawInput,
        }) as Item & { k: "tool" };
        p.tools.set(e.id, item);
        return false;
      }
      case "tool_update": {
        const t = p.tools.get(e.id);
        const raw = e.raw ?? {};
        if (!t) return false;
        if (e.status) t.status = e.status;
        if (e.title) t.title = e.title;
        if (raw.content) t.content = capContent(raw.content);
        if (raw.locations) t.locations = raw.locations;
        if (raw.rawInput) t.rawInput = raw.rawInput;
        this.touch(name, t);
        return false;
      }
      case "plan":
        if (last?.k === "plan") {
          last.entries = e.entries ?? [];
          this.touch(name, last);
        } else this.push(name, { k: "plan", entries: e.entries ?? [] });
        return false;
      case "turn_end":
        this.push(name, { k: "turn", stopReason: e.stopReason, tokens: e.usage?.totalTokens, ts: Date.now() });
        this.turnEnded(name, e.stopReason);
        for (const f of turnEndHooks) f(name, e.stopReason);
        return true;
      case "session":
        // Tool ids restart per session in some agents.
        p.tools.clear();
        this.push(name, { k: "session", how: e.how, sessionId: e.sessionId });
        return false;
      case "notice":
        if (!String(e.text).startsWith("[stderr]")) this.push(name, { k: "notice", text: e.text });
        return false;
      case "status":
        if (e.status === "error" && e.note) this.push(name, { k: "notice", text: e.note, level: "error" });
        return true;
      case "exit":
        this.push(name, { k: "notice", text: `agent process exited (${e.code})`, level: "error" });
        return true;
      default:
        return false;
    }
  }

  /** Rebuild a pane's transcript from the events table (after resume/restart). */
  loadHistory(name: string, rows: { ts: number; type: string; data: any }[]) {
    const p = this.pane(name);
    if (p.loadedHistory) return;
    p.loadedHistory = true;
    const items: ItemBody[] = [];
    const seenTools = new Set<string>();
    for (const r of rows) {
      if (r.type === "prompt") items.push({ k: "user", text: r.data.text, ts: r.ts });
      else if (r.type === "reply") items.push({ k: "agent", text: r.data.text });
      else if (r.type === "tool_call") {
        if (seenTools.has(r.data.id)) continue;
        seenTools.add(r.data.id);
        items.push({ k: "tool", toolId: `h${r.data.id}`, title: r.data.title, kind: r.data.kind, status: "completed", content: [], locations: [] });
      }
      else if (r.type === "turn_end") items.push({ k: "turn", stopReason: r.data.stopReason, tokens: r.data.usage?.totalTokens, ts: r.ts });
    }
    if (items.length) items.push({ k: "notice", text: "— history above; live below —" });
    p.items = [...items.map((b) => ({ ...b, id: nextItemId++, rev: 0 }) as Item), ...p.items];
    p.history = rows.filter((r) => r.type === "prompt" && !String(r.data.text).startsWith("You have ")).map((r) => r.data.text).slice(-50);
    p.version++;
    this.bump();
  }

  /** Apply a full backend snapshot (startup, renderer reload, backend restart). */
  applyState(st: { ready: Extract<BackendEvent, { event: "ready" }>; agents: AgentView[]; permissions: PermissionAsk[]; elicitations: ElicitationAsk[]; ownerUnread?: number }) {
    this.ownerUnread = st.ownerUnread ?? 0;
    this.kinds = st.ready.kinds;
    this.presets = st.ready.presets ?? [];
    this.cwd = st.ready.cwd;
    this.db = st.ready.db;
    this.layout = st.ready.layout;
    this.agents = new Map(st.agents.map((a) => [a.name, a]));
    for (const a of st.permissions) this.addAsk(a.agent, { k: "permission", ask: a });
    for (const a of st.elicitations) this.addAsk(a.agent, { k: "elicitation", ask: a });
    this.ready = true;
    this.changed();
  }
}

/** Called after a pane's agent finishes a turn (voice: speak the reply). */
const turnEndHooks = new Set<(name: string, stopReason: string) => void>();
export function onTurnEnd(fn: (name: string, stopReason: string) => void) {
  turnEndHooks.add(fn);
  return () => void turnEndHooks.delete(fn);
}

export const store = new Store();

/** Re-render on any store change (the snapshot is the version counter). */
export function useStore<T>(select: (s: Store) => T): T {
  useSyncExternalStore(store.subscribe, () => store.version);
  return select(store);
}

/** Re-render a pane when its own transcript changes. */
export function usePane(name: string): PaneState {
  useSyncExternalStore(store.subscribe, () => store.pane(name).version);
  return store.pane(name);
}

let lastPing = 0;
let audio: AudioContext | undefined;
/** A short two-note chime (no audio files, works offline). */
export function ping() {
  if (Date.now() - lastPing < 1500) return;
  lastPing = Date.now();
  try {
    audio ??= new AudioContext();
    const t = audio.currentTime;
    for (const [i, f] of [880, 1320].entries()) {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.18, t + i * 0.12 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.25);
      o.connect(g).connect(audio.destination);
      o.start(t + i * 0.12);
      o.stop(t + i * 0.12 + 0.3);
    }
  } catch {}
}

function notifyAttention(agent: string, what: string, verb = "needs you") {
  if (document.hasFocus()) return;
  try {
    window.hiveBridge?.attention?.();
  } catch {}
  try {
    new Notification(`hive: ${agent} ${verb}`, { body: what.slice(0, 120), silent: false });
  } catch {}
}
