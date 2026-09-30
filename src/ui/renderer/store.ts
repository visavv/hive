/**
 * Renderer state: per-pane transcript items built from SessionEvents, plus
 * the agent/job lists and pending permission/elicitation asks. A tiny
 * external store (useSyncExternalStore) so streaming chunks don't re-render
 * every pane.
 */
import { useSyncExternalStore } from "react";
import type { AgentView, BackendEvent, ElicitationAsk, JobView, Layout, PermissionAsk, PresetView } from "../protocol.js";

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
  starting = new Map<string, { kind: string; error?: string }>();
  jobs: JobView[] = [];
  kinds: { id: string; label: string }[] = [];
  presets: PresetView[] = [];
  /** Unread mail agents sent to the owner. */
  ownerUnread = 0;
  cwd = "";
  db = "";
  layout: Layout = { panes: [], columns: 2, hoverFocus: true, sidebar: true, maximized: null };
  ready = false;
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
    const id = ++this.toastId;
    this.toasts.push({ id, text, level });
    setTimeout(() => {
      this.toasts = this.toasts.filter((t) => t.id !== id);
      this.changed();
    }, level === "error" ? 8000 : 4000);
    this.changed();
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
      case "agents":
        this.agents = new Map(ev.agents.map((a) => [a.name, a]));
        break;
      case "jobs":
        this.jobs = ev.jobs;
        break;
      case "job":
        this.push(ev.agent, { k: "notice", text: ev.text });
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

  /** Returns true when the change matters beyond this pane's transcript. */
  private applyAgent(name: string, e: any): boolean {
    const p = this.pane(name);
    const last = p.items[p.items.length - 1];
    switch (e.type) {
      case "prompt":
        this.push(name, { k: "user", text: e.text, ts: Date.now() });
        return false;
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
        return false;
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

function notifyAttention(agent: string, what: string, verb = "needs you") {
  if (document.hasFocus()) return;
  try {
    window.hiveBridge?.attention?.();
  } catch {}
  try {
    new Notification(`hive: ${agent} ${verb}`, { body: what.slice(0, 120), silent: false });
  } catch {}
}
