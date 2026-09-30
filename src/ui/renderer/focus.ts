/**
 * Phase 4 input routing: which pane input has focus. Hover-to-focus, Ctrl+1..9,
 * Ctrl+Tab and the global "focus last" hotkey all go through here, so Handy
 * (OS-level speech-to-text) types into whichever pane the user is looking at.
 */
const inputs = new Map<string, HTMLTextAreaElement>();
let order: string[] = [];
let active: string | undefined;

/** Last keystroke into a pane input: hover must not move focus mid-dictation. */
let lastKeyAt = 0;
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
  if (isPaneInput) return Date.now() - lastKeyAt < TYPING_LOCK_MS;
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
    active = name;
  },
  get active() {
    return active;
  },
  to(name: string | undefined) {
    if (!name) return;
    const el = inputs.get(name);
    if (!el) return;
    active = name;
    el.focus({ preventScroll: true });
    el.closest(".pane")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  },
  hover(name: string) {
    if (focusIsProtected() || window.getSelection()?.toString()) return;
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
