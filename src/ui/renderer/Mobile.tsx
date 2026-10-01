/**
 * Phone layout (below 760px wide): one agent at a time, full screen, with a
 * bottom bar of agents (state dot each), Board, Inbox and Menu. Swipe left or
 * right on the transcript for the next agent. Dialogs, the palette and the
 * board become full-screen sheets (styles.css, "mobile" block), and the Back
 * button / gesture closes them before it leaves the app.
 *
 * App.tsx keeps rendering the same panes and dialogs; it only asks here which
 * single agent to show and adds the bar.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { store, useStore } from "./store.js";
import { focus, overlays, useOverlay } from "./focus.js";
import { agentState, STATE_LABEL } from "./state.js";
import { IconColumns, IconInbox, IconMenu, IconPlus } from "./Icons.js";
import type { PaletteAction } from "./Palette.js";

export const MOBILE_QUERY = "(max-width: 760px)";

export function useMobile(): boolean {
  const [m, setM] = useState(() => window.matchMedia(MOBILE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const f = () => setM(mq.matches);
    mq.addEventListener("change", f);
    return () => mq.removeEventListener("change", f);
  }, []);
  return m;
}

// ---- which agent is on screen ----

let current: string | undefined;
const subs = new Set<() => void>();
function show(name: string) {
  if (current !== name) {
    current = name;
    subs.forEach((f) => f());
  }
  focus.setActive(name);
  store.clearReady(name);
}
// Ctrl+K "go to agent", "needs you" jumps, a new agent: whatever asks for a pane's focus brings it on screen.
focus.onRequest((name) => {
  if (window.matchMedia(MOBILE_QUERY).matches) show(name);
});
const subscribe = (fn: () => void) => (subs.add(fn), () => void subs.delete(fn));

/** The agent the phone layout shows: the last one picked, else the focused one, else the first. */
export function useMobileAgent(names: string[]): string | undefined {
  const cur = useSyncExternalStore(subscribe, () => current);
  const active = useSyncExternalStore(focus.subscribe, () => focus.active);
  if (cur && names.includes(cur)) return cur;
  if (active && names.includes(active)) return active;
  return names[0];
}

// ---- bottom bar ----

export function MobileNav({ names, actions, board, onBoard, onInbox, onPalette }: {
  names: string[];
  actions: PaletteAction[];
  board: boolean;
  onBoard: () => void;
  onInbox: () => void;
  onPalette: () => void;
}) {
  const cur = useMobileAgent(names);
  const unread = useStore((s) => s.ownerUnread + s.heldTotal);
  // re-render on any state change: the dots follow every agent
  const states = useStore(() => names.map((n) => agentState(n)).join("|")).split("|");
  const [menu, setMenu] = useState(false);
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    strip.current?.querySelector(".on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [cur]);
  useSwipe(names, cur);
  useBackButton();
  useKeyboardOpen();
  const pick = (n: string) => {
    if (board) onBoard(); // the board covers the panes: picking an agent goes back to it
    show(n);
  };
  const newAgent = actions.find((a) => a.id === "new");
  return (
    <>
      <nav className="mnav" aria-label="agents and views">
        <div className="mnav-agents" ref={strip} role="tablist" aria-label="agents">
          {names.map((n, i) => (
            <button
              key={n}
              role="tab"
              aria-selected={n === cur && !board}
              className={`mnav-agent st-${states[i]}${n === cur && !board ? " on" : ""}`}
              onClick={() => pick(n)}
              title={`${n} — ${STATE_LABEL[states[i] as keyof typeof STATE_LABEL] ?? ""}`}
            >
              <span className="st-dot" aria-hidden="true" />
              <span className="mnav-name">{n}</span>
            </button>
          ))}
          {newAgent && (
            <button className="mnav-agent mnav-add" onClick={newAgent.run} aria-label="add agent" title="add agent">
              <IconPlus size={18} />
              {names.length === 0 && <span className="mnav-name">Agent</span>}
            </button>
          )}
        </div>
        <button className={`mnav-btn${board ? " on" : ""}`} onClick={onBoard} aria-pressed={board}>
          <IconColumns size={20} />
          <span>Board</span>
        </button>
        <button className="mnav-btn" onClick={onInbox}>
          <IconInbox size={20} />
          <span>Inbox</span>
          {unread > 0 && <span className="count">{unread}</span>}
        </button>
        <button className="mnav-btn" onClick={() => setMenu(true)} aria-haspopup="dialog">
          <IconMenu size={20} />
          <span>Menu</span>
        </button>
      </nav>
      {menu && <MobileMenu actions={actions} onPalette={onPalette} onClose={() => setMenu(false)} />}
    </>
  );
}

/** The things you reach for on a phone; everything else is under "All commands". */
const MENU = ["new", "team", "skills", "verdict", "link", "usage", "stats"];

function MobileMenu({ actions, onPalette, onClose }: { actions: PaletteAction[]; onPalette: () => void; onClose: () => void }) {
  useOverlay("modal", onClose);
  const run = (f: () => void) => {
    onClose();
    // after this sheet's Back-button entry is gone, so the next sheet gets its own
    setTimeout(f, 0);
  };
  const items = MENU.map((id) => actions.find((a) => a.id === id)).filter((a): a is PaletteAction => !!a);
  const app = (window as any).HiveAndroid as { openSetup?: () => void } | undefined;
  return (
    <div className="modal-back msheet-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="msheet" role="dialog" aria-modal="true" aria-label="Menu">
        <div className="msheet-grip" aria-hidden="true" />
        {items.map((a) => (
          <button key={a.id} className="msheet-item" onClick={() => run(a.run)}>
            <span>{a.label}</span>
            {a.hint && <span className="dim small">{a.hint}</span>}
          </button>
        ))}
        <button className="msheet-item" onClick={() => run(onPalette)}>
          <span>All commands, themes and agents…</span>
        </button>
        {app?.openSetup && (
          <button className="msheet-item" onClick={() => app.openSetup!()}>
            <span>Change hive address</span>
            <span className="dim small">connect this app to another computer or project</span>
          </button>
        )}
        <button className="msheet-item ghost" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

// ---- gestures and the system Back button ----

/** Horizontal swipe on the agent's transcript: next / previous agent. */
function useSwipe(names: string[], cur: string | undefined) {
  const state = useRef({ names, cur });
  state.current = { names, cur };
  useEffect(() => {
    let start: { x: number; y: number; t: number } | null = null;
    const down = (e: TouchEvent) => {
      const t = e.target as HTMLElement;
      // things that scroll sideways or take text keep their own gestures
      if (e.touches.length !== 1 || !t.closest(".grid .transcript") || t.closest("pre, table, .diff, input, textarea, select, .ask") || overlays.top) {
        start = null;
        return;
      }
      start = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
    };
    const up = (e: TouchEvent) => {
      if (!start) return;
      const dx = e.changedTouches[0].clientX - start.x;
      const dy = e.changedTouches[0].clientY - start.y;
      const quick = Date.now() - start.t < 600;
      start = null;
      if (!quick || Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 2) return;
      const { names, cur } = state.current;
      const i = cur ? names.indexOf(cur) : -1;
      const next = names[i + (dx < 0 ? 1 : -1)];
      if (next) show(next);
    };
    document.addEventListener("touchstart", down, { passive: true });
    document.addEventListener("touchend", up, { passive: true });
    return () => {
      document.removeEventListener("touchstart", down);
      document.removeEventListener("touchend", up);
    };
  }, []);
}

/**
 * Each open sheet (dialog, palette, board, inbox) gets a history entry, so the
 * Android Back button closes it (via the Escape every overlay already listens
 * for) instead of leaving hive.
 */
function useBackButton() {
  useEffect(() => {
    let depth = 0; // entries we pushed
    let going = false; // our own history.go() hasn't landed yet
    const sync = () => {
      if (going) return;
      const d = overlays.depth;
      if (depth > d) {
        // closed with a button, not Back: drop the entries it had
        const n = depth - d;
        depth = d;
        going = true;
        history.go(-n);
        return;
      }
      while (depth < d) history.pushState({ hiveSheet: ++depth }, "");
    };
    const pop = () => {
      if (going) {
        going = false;
        return sync(); // a sheet may have opened meanwhile
      }
      if (depth > 0) {
        depth--;
        if (overlays.depth > 0) window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      }
    };
    const off = overlays.subscribe(() => setTimeout(sync, 0));
    window.addEventListener("popstate", pop);
    return () => {
      off();
      window.removeEventListener("popstate", pop);
    };
  }, []);
}

/** The on-screen keyboard is up: hide the bottom bar so the composer and the transcript keep the room. */
function useKeyboardOpen() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let tallest = 0;
    let width = 0;
    const check = () => {
      if (window.innerWidth !== width) {
        width = window.innerWidth; // rotated: start over
        tallest = 0;
      }
      tallest = Math.max(tallest, vv.height);
      const open = vv.height < tallest * 0.78 && !!document.activeElement?.matches("input, textarea, [contenteditable]");
      document.documentElement.toggleAttribute("data-keyboard", open);
    };
    const later = () => setTimeout(check, 50);
    check();
    vv.addEventListener("resize", check);
    document.addEventListener("focusout", later);
    return () => {
      vv.removeEventListener("resize", check);
      document.removeEventListener("focusout", later);
      document.documentElement.removeAttribute("data-keyboard");
    };
  }, []);
}
