/**
 * Renderer state: per-pane transcript items built from SessionEvents, plus
 * the agent/job lists and pending permission/elicitation asks. A tiny
 * external store (useSyncExternalStore) so streaming chunks don't re-render
 * every pane.
 */
import { useSyncExternalStore } from "react";
import type { AgentView, BackendEvent, ElicitationAsk, JobView, Layout, PermissionAsk, PresetView } from "../protocol.js";

export type Item =
  | { k: "user"; text: string; ts: number }
  | { k: "agent"; text: string }
  | { k: "thought"; text: string }
  | { k: "tool"; id: string; title: string; kind?: string; status: string; content: any[]; locations: any[]; rawInput?: unknown }
  | { k: "plan"; entries: { content: string; status: string; priority?: string }[] }
  | { k: "permission"; ask: PermissionAsk; decided?: string }
  | { k: "elicitation"; ask: ElicitationAsk; done?: string }
  | { k: "notice"; text: string; level?: "info" | "error" }
  | { k: "turn"; stopReason: string; tokens?: number; ts: number }
  | { k: "session"; how: string; id: string };

export interface PaneState {
  items: Item[];
  version: number;
  /** Items keyed by tool id for in-place updates. */
  tools: Map<string, Item & { k: "tool" }>;
  history: string[];
  loadedHistory: boolean;
}

const MAX_ITEMS = 1500;

class Store {
  panes = new Map<string, PaneState>();
  agents = new Map<string, AgentView>();
  starting = new Map<string, { kind: string; error?: string }>();
  jobs: JobView[] = [];
  kinds: { id: string; label: string }[] = [];
  presets: PresetView[] = [];
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
      this.version++;
      for (const s of this.subs) s();
    });
  }

  pane(name: string): PaneState {
    let p = this.panes.get(name);
    if (!p) {
      p = { items: [], version: 0, tools: new Map(), history: [], loadedHistory: false };
      this.panes.set(name, p);
    }
    return p;
  }

  push(name: string, item: Item) {
    const p = this.pane(name);
    p.items.push(item);
    if (p.items.length > MAX_ITEMS) p.items.splice(0, p.items.length - MAX_ITEMS);
    p.version++;
  }

  toast(text: string, level: "info" | "error" = "info") {
    const id = ++this.toastId;
    this.toasts.push({ id, text, level });
    setTimeout(() => {
      this.toasts = this.toasts.filter((t) => t.id !== id);
      this.bump();
    }, level === "error" ? 8000 : 4000);
    this.bump();
  }

  /** Items that need the user (for the sidebar badge and title). */
  waitingOn(name: string): number {
    const p = this.panes.get(name);
    if (!p) return 0;
    return p.items.filter((i) => (i.k === "permission" && !i.decided) || (i.k === "elicitation" && !i.done)).length;
  }

  apply(ev: BackendEvent) {
    switch (ev.event) {
      case "ready":
        this.kinds = ev.kinds;
        this.presets = ev.presets ?? [];
        this.cwd = ev.cwd;
        this.db = ev.db;
        if (!this.ready) this.layout = ev.layout;
        this.ready = true;
        break;
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
        this.push(ev.ask.agent, { k: "permission", ask: ev.ask });
        notifyAttention(ev.ask.agent, ev.ask.title);
        break;
      case "permission_done":
        for (const p of this.panes.values())
          for (const i of p.items)
            if (i.k === "permission" && i.ask.reqId === ev.reqId && !i.decided) {
              i.decided = "answered";
              p.version++;
            }
        break;
      case "elicitation":
        this.push(ev.ask.agent, { k: "elicitation", ask: ev.ask });
        notifyAttention(ev.ask.agent, ev.ask.message);
        break;
      case "elicitation_done":
        for (const p of this.panes.values())
          for (const i of p.items)
            if (i.k === "elicitation" && i.ask.reqId === ev.reqId && !i.done) {
              i.done = "answered";
              p.version++;
            }
        break;
      case "agent":
        this.applyAgent(ev.agent, ev.e as any);
        break;
    }
    this.bump();
  }

  private applyAgent(name: string, e: any) {
    const p = this.pane(name);
    const last = p.items[p.items.length - 1];
    switch (e.type) {
      case "prompt":
        this.push(name, { k: "user", text: e.text, ts: Date.now() });
        break;
      case "text":
        if (last?.k === "agent") {
          last.text += e.text;
          p.version++;
        } else this.push(name, { k: "agent", text: e.text });
        break;
      case "thought":
        if (last?.k === "thought") {
          last.text += e.text;
          p.version++;
        } else this.push(name, { k: "thought", text: e.text });
        break;
      case "tool_call": {
        const raw = e.raw ?? {};
        // Some agents re-send tool_call (not tool_call_update) for the same id.
        const existing = p.tools.get(e.id);
        if (existing) {
          existing.status = e.status ?? existing.status;
          existing.title = e.title ?? existing.title;
          if (raw.content) existing.content = raw.content;
          if (raw.locations) existing.locations = raw.locations;
          p.version++;
          break;
        }
        const item: Item & { k: "tool" } = {
          k: "tool",
          id: e.id,
          title: e.title,
          kind: e.kind,
          status: e.status,
          content: raw.content ?? [],
          locations: raw.locations ?? [],
          rawInput: raw.rawInput,
        };
        p.tools.set(e.id, item);
        this.push(name, item);
        break;
      }
      case "tool_update": {
        const t = p.tools.get(e.id);
        const raw = e.raw ?? {};
        if (!t) break;
        if (e.status) t.status = e.status;
        if (e.title) t.title = e.title;
        if (raw.content) t.content = raw.content;
        if (raw.locations) t.locations = raw.locations;
        if (raw.rawInput) t.rawInput = raw.rawInput;
        p.version++;
        break;
      }
      case "plan":
        if (last?.k === "plan") {
          last.entries = e.entries ?? [];
          p.version++;
        } else this.push(name, { k: "plan", entries: e.entries ?? [] });
        break;
      case "turn_end":
        this.push(name, { k: "turn", stopReason: e.stopReason, tokens: e.usage?.totalTokens, ts: Date.now() });
        break;
      case "session":
        this.push(name, { k: "session", how: e.how, id: e.sessionId });
        break;
      case "notice":
        if (!String(e.text).startsWith("[stderr]")) this.push(name, { k: "notice", text: e.text });
        break;
      case "status":
        if (e.status === "error" && e.note) this.push(name, { k: "notice", text: e.note, level: "error" });
        break;
      case "exit":
        this.push(name, { k: "notice", text: `agent process exited (${e.code})`, level: "error" });
        break;
      case "elicitation":
      case "permission":
        break; // shown via the interactive ask items
    }
  }

  /** Rebuild a pane's transcript from the events table (after resume/restart). */
  loadHistory(name: string, rows: { ts: number; type: string; data: any }[]) {
    const p = this.pane(name);
    if (p.loadedHistory) return;
    p.loadedHistory = true;
    const items: Item[] = [];
    const seenTools = new Set<string>();
    for (const r of rows) {
      if (r.type === "prompt") items.push({ k: "user", text: r.data.text, ts: r.ts });
      else if (r.type === "reply") items.push({ k: "agent", text: r.data.text });
      else if (r.type === "tool_call") {
        if (seenTools.has(r.data.id)) continue;
        seenTools.add(r.data.id);
        items.push({ k: "tool", id: `h${r.data.id}`, title: r.data.title, kind: r.data.kind, status: "completed", content: [], locations: [] });
      }
      else if (r.type === "turn_end") items.push({ k: "turn", stopReason: r.data.stopReason, tokens: r.data.usage?.totalTokens, ts: r.ts });
    }
    if (items.length) items.push({ k: "notice", text: "— history above; live below —" });
    p.items = [...items, ...p.items];
    p.history = rows.filter((r) => r.type === "prompt" && !String(r.data.text).startsWith("You have ")).map((r) => r.data.text).slice(-50);
    p.version++;
    this.bump();
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

function notifyAttention(agent: string, what: string) {
  if (document.hasFocus()) return;
  try {
    new Notification(`hive: ${agent} needs you`, { body: what.slice(0, 120), silent: false });
  } catch {}
}
