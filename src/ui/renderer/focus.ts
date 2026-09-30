/**
 * Phase 4 input routing: which pane input has focus. Hover-to-focus, Ctrl+1..9,
 * Ctrl+Tab and the global "focus last" hotkey all go through here, so Handy
 * (OS-level speech-to-text) types into whichever pane the user is looking at.
 */
const inputs = new Map<string, HTMLTextAreaElement>();
let order: string[] = [];
let active: string | undefined;

/** Don't steal focus from dialogs or a broadcast message being written. */
function focusIsProtected(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el.closest("dialog, .modal")) return true;
  if (el.closest(".broadcast") && (el as HTMLInputElement).value) return true;
  if (el.tagName === "SELECT") return true;
  return false;
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
    if (!order.length) return;
    const i = active ? order.indexOf(active) : -1;
    this.to(order[(i + dir + order.length) % order.length]);
  },
  last() {
    this.to(active ?? order[0]);
  },
};
