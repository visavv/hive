/** The pane layout: saving it, maximizing a pane, opening a pane (starts or resumes its agent). */
import type { Layout, PaneSpec } from "../protocol.js";
import { rpc } from "./bridge.js";
import { store } from "./store.js";

export function saveLayout(patch: Partial<Layout>) {
  store.layout = { ...store.layout, ...patch };
  store.changed();
  void rpc("saveLayout", store.layout);
}

/** The maximized pane, or null when none is (or the saved name is no longer open). */
export function maxedName(l: Layout): string | null {
  return l.maximized && l.panes.some((p) => p.name === l.maximized) ? l.maximized : null;
}

/** Maximize / restore a pane; ignores names that aren't open (e.g. a pane just closed). */
export function toggleMaximize(name: string | undefined) {
  if (!name || !store.layout.panes.some((p) => p.name === name)) return;
  saveLayout({ maximized: maxedName(store.layout) === name ? null : name });
}

export async function openPane(spec: PaneSpec, persist = true, startJob = false) {
  if (persist && !store.layout.panes.some((p) => p.name === spec.name)) saveLayout({ panes: [...store.layout.panes, spec] });
  store.starting.set(spec.name, { kind: spec.kind });
  store.changed();
  try {
    await rpc("addAgent", { ...spec, resume: true, startJob });
    store.starting.delete(spec.name);
    const rows = await rpc("history", { name: spec.name, limit: 120 });
    store.loadHistory(spec.name, rows);
  } catch (e: any) {
    store.starting.set(spec.name, { kind: spec.kind, error: e.message });
  }
  store.changed();
}
