/**
 * Phase 4 input routing: which pane input has focus. Hover-to-focus, Ctrl+1..9,
 * Ctrl+Tab and the global "focus last" hotkey all go through here, so Handy
 * (OS-level speech-to-text) types into whichever pane the user is looking at.
 */
import { useEffect, useRef } from "react";

const inputs = new Map<string, HTMLTextAreaElement>();
let order: string[] = [];
let active: string | undefined;
/** focus.to() on a pane whose input isn't usable yet (agent still starting): focus it once it is. */
let pending: { name: string; at: number } | undefined;
const PENDING_MS = 60_000;
const subs = new Set<() => void>();
/** Every focus.to() request, even for a pane that isn't on screen (the phone layout shows one agent and switches to it). */
const requests = new Set<(name: string) => void>();
function setActiveName(name: string | undefined) {
  if (active === name) return;
  active = name;
  for (const s of subs) s();
}

/** Last keystroke into a pane input: hover must not move focus mid-dictation. */
let lastKeyAt = 0;
let dwell: ReturnType<typeof setTimeout> | undefined;
const HOVER_DWELL_MS = 450;
const TYPING_LOCK_MS = 1500;
document.addEventListener(
  "keydown",
  (e) => {
    if ([...inputs.values()].includes(e.target as HTMLTextAreaElement)) lastKeyAt = Date.now();
  },
  true,
);

/**
 * Don't steal focus from: any field that isn't a pane input (dialogs, the
 * broadcast box, a question form inside a pane, selects), or a pane input
 * that is being typed into right now (Handy types via keystrokes; moving the
 * mouse mid-sentence would split it across panes).
 */
function focusIsProtected(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) return false;
  const isPaneInput = [...inputs.values()].includes(el as HTMLTextAreaElement);
  // A draft (e.g. mid-dictation, Handy types when you stop talking) stays put
  // until you click elsewhere or send it.
  if (isPaneInput) return Date.now() - lastKeyAt < TYPING_LOCK_MS || (el as HTMLTextAreaElement).value.trim() !== "";
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
}

export const focus = {
  register(name: string, el: HTMLTextAreaElement) {
    inputs.set(name, el);
  },
  unregister(name: string) {
    inputs.delete(name);
  },
  setOrder(names: string[]) {
    order = names;
  },
  setActive(name: string) {
    setActiveName(name);
  },
  get active() {
    return active;
  },
  /** The pane closed: it is no longer the focus target (Ctrl+M, "focus last"). */
  forget(name: string) {
    if (active === name) setActiveName(undefined);
    if (pending?.name === name) pending = undefined;
  },
  /** Re-render on active-pane changes (sidebar highlight). */
  subscribe(fn: () => void) {
    subs.add(fn);
    return () => void subs.delete(fn);
  },
  onRequest(fn: (name: string) => void) {
    requests.add(fn);
    return () => void requests.delete(fn);
  },
  /** A pane's input just became usable: take a focus request that arrived too early. */
  ready(name: string) {
    if (pending?.name !== name) return;
    const fresh = Date.now() - pending.at < PENDING_MS;
    pending = undefined;
    if (fresh && !overlays.top && !focusIsProtected()) this.to(name);
  },
  to(name: string | undefined) {
    if (!name) return;
    for (const r of requests) r(name);
    const el = inputs.get(name);
    pending = undefined;
    if (!el || el.disabled) {
      pending = { name, at: Date.now() };
      return;
    }
    setActiveName(name);
    el.focus({ preventScroll: true });
    el.closest(".pane")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  },
  /** Hover with a short dwell, so sweeping the mouse across panes doesn't move focus. */
  hoverStart(name: string) {
    clearTimeout(dwell);
    dwell = setTimeout(() => this.hover(name), HOVER_DWELL_MS);
  },
  hoverEnd() {
    clearTimeout(dwell);
  },
  hover(name: string) {
    if (overlays.top || focusIsProtected() || window.getSelection()?.toString()) return;
    if (document.activeElement === inputs.get(name)) return;
    this.to(name);
  },
  nth(i: number) {
    this.to(order[i]);
  },
  cycle(dir: 1 | -1) {
    // Only panes that are on screen (a maximized layout hides the others).
    const live = order.filter((n) => inputs.has(n) && inputs.get(n)!.isConnected);
    if (!live.length) return;
    const i = active ? live.indexOf(active) : -1;
    this.to(live[(i + dir + live.length) % live.length]);
  },
  last() {
    this.to(active ?? order[0]);
  },
};

// ---- overlays (dialogs, the Hive drawer, the command palette) ----

export type OverlayKind = "modal" | "drawer" | "palette";
const stack: { kind: OverlayKind }[] = [];
const stackSubs = new Set<() => void>();
const stackChanged = () => stackSubs.forEach((f) => f());

/** The open overlays, newest on top. Only the top one reacts to Escape or traps Tab. */
export const overlays = {
  get top(): OverlayKind | undefined {
    return stack[stack.length - 1]?.kind;
  },
  get depth(): number {
    return stack.length;
  },
  /** Overlay opened or closed (the phone layout maps them to Back-button history entries). */
  subscribe(fn: () => void) {
    stackSubs.add(fn);
    return () => void stackSubs.delete(fn);
  },
};

/**
 * Register an overlay while mounted. Escape closes only the topmost one and goes
 * no further (capture phase, so a pane composer behind it never sees the Escape
 * and doesn't cancel the agent's turn). Returns whether this overlay is on top.
 */
export function useOverlay(kind: OverlayKind, onClose: () => void): () => boolean {
  const me = useRef({ kind });
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const entry = me.current;
    stack.push(entry);
    stackChanged();
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || stack[stack.length - 1] !== entry) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      // It unmounts on a later frame: stop counting it now, so a quick next key (Ctrl+K) isn't swallowed.
      stack.splice(stack.indexOf(entry), 1);
      stackChanged();
      close.current();
    };
    window.addEventListener("keydown", k, true);
    return () => {
      window.removeEventListener("keydown", k, true);
      const i = stack.indexOf(entry);
      if (i >= 0) {
        stack.splice(i, 1);
        stackChanged();
      }
    };
  }, []);
  return () => stack[stack.length - 1] === me.current;
}

/** Enter/Space on an element that acts like a button (role="button", tabIndex 0). */
export function onActivate(run: () => void) {
  return (e: { key: string; target: EventTarget; currentTarget: EventTarget; preventDefault(): void }) => {
    if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    run();
  };
}
