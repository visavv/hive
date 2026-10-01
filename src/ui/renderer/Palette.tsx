/**
 * Command palette (Ctrl+K), after T3 Code / Odysseus, with herdr's "go to
 * agent" built in: every agent with its state, plus every action, each with
 * its shortcut. Type to filter (state words work too: "needs", "working",
 * "done"); ↑/↓ and Enter.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { store, useStore } from "./store.js";
import { focus, useOverlay } from "./focus.js";
import { saveLayout } from "./App.js";
import { agentState, STATE_LABEL, StatePill } from "./state.js";

export interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
  keys?: string;
  run: () => void;
}

export function Palette({ actions, onClose }: { actions: PaletteAction[]; onClose: () => void }) {
  const names = useStore((s) => s.layout.panes.map((p) => p.name));
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  useOverlay("palette", onClose);
  const items = useMemo(() => {
    const agents = names.map((n, i) => {
      const st = agentState(n);
      const a = store.agents.get(n);
      return {
        id: "agent:" + n,
        label: n,
        hint: `${a?.kind ?? store.starting.get(n)?.kind ?? ""}${a?.branch?.startsWith("hive/") ? " · " + a.branch : ""}`,
        keys: i < 9 ? `Ctrl+${i + 1}` : undefined,
        state: st,
        run: () => {
          if (store.layout.maximized && store.layout.maximized !== n) saveLayout({ maximized: null });
          setTimeout(() => focus.to(n), 0);
        },
      };
    });
    const all = [...agents, ...actions.map((a) => ({ ...a, state: undefined }))];
    const t = q.trim().toLowerCase();
    if (!t) return all;
    return all
      .map((it) => {
        const hay = `${it.label} ${it.hint ?? ""} ${it.state ? STATE_LABEL[it.state] : ""}`.toLowerCase();
        const score = it.label.toLowerCase().startsWith(t) ? 0 : hay.includes(t) ? 1 : t.split(/\s+/).every((w) => hay.includes(w)) ? 2 : -1;
        return { it, score };
      })
      .filter((x) => x.score >= 0)
      .sort((a, b) => a.score - b.score)
      .map((x) => x.it);
  }, [q, names.join("|"), actions]);
  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(".pal-item.on")?.scrollIntoView({ block: "nearest" });
  }, [sel]);
  const run = (i: number) => {
    const it = items[i];
    if (!it) return;
    onClose();
    it.run();
  };
  return (
    <div className="modal-back pal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          autoFocus
          className="pal-input"
          value={q}
          placeholder="Jump to an agent or run a command…"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(items.length - 1, s + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(0, s - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              run(sel);
            }
          }}
          aria-label="search agents and commands"
        />
        <div className="pal-list" ref={listRef} role="listbox">
          {items.length === 0 && <div className="pal-empty">No matches</div>}
          {items.map((it, i) => (
            <div
              key={it.id}
              role="option"
              aria-selected={i === sel}
              className={`pal-item${i === sel ? " on" : ""}${it.id.startsWith("agent:") ? " agent" : ""}`}
              onMouseEnter={() => setSel(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                run(i);
              }}
            >
              {it.state ? <StatePill state={it.state} compact /> : <span className="pal-ico">›</span>}
              <span className="pal-label">{it.label}</span>
              {it.hint && <span className="pal-hint">{it.hint}</span>}
              <span className="spacer" />
              {it.state && <span className={`pal-state st-${it.state}`}>{STATE_LABEL[it.state]}</span>}
              {it.keys && <kbd>{it.keys}</kbd>}
            </div>
          ))}
        </div>
        <div className="pal-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>Enter</kbd> open
          </span>
          <span>
            <kbd>Esc</kbd> close
          </span>
          <span className="spacer" />
          <span>type "needs", "working" or "done" to filter agents by state</span>
        </div>
      </div>
    </div>
  );
}
