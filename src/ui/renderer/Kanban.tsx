/**
 * The board: Draft and In progress side by side, Done hidden until you ask for it.
 * Drag cards between and within columns; click one to edit it or hand it to an agent.
 * Agents and automations add cards too (hive_card_add), so it refreshes while open.
 */
import { useEffect, useRef, useState } from "react";
import { rpc } from "./bridge.js";
import { store } from "./store.js";
import { focus, useOverlay } from "./focus.js";
import { IconClose, IconPlus, IconSearch } from "./Icons.js";

type BoardData = Awaited<ReturnType<typeof rpc<"board">>>;
type Card = BoardData["cards"][number];
type Col = "draft" | "doing" | "done";
const LABEL: Record<Col, string> = { draft: "Draft", doing: "In progress", done: "Done" };

export function KanbanView({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<BoardData | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [project, setProject] = useState("");
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<Card | null>(null);
  const [drag, setDrag] = useState<{ id: number; over?: Col; before?: number | null } | null>(null);
  useOverlay("modal", onClose); // Esc closes the board; pane shortcuts wait while it's open
  const load = () =>
    void rpc("board", { done: showDone, project: project || undefined, q: q || undefined })
      .then(setData)
      .catch((e) => store.toast(e.message, "error"));
  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [showDone, project, q]);
  const act = (p: Promise<unknown>) => void p.then(load).catch((e) => store.toast(e.message, "error"));

  const drop = (col: Col) => {
    if (!drag) return;
    act(rpc("cardMove", { id: drag.id, col, before: drag.before ?? null }));
    setDrag(null);
  };
  const cols: Col[] = showDone ? ["draft", "doing", "done"] : ["draft", "doing"];
  return (
    <div className="kanban">
      <div className="kb-bar">
        <strong>Board</strong>
        <label className="kb-search">
          <IconSearch size={14} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search cards" aria-label="search cards" />
        </label>
        <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="filter by project">
          <option value="">All projects</option>
          {data?.projects.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <span className="spacer" />
        <button className={`ghost${showDone ? " on" : ""}`} onClick={() => setShowDone((v) => !v)} title="Done cards are hidden; show them to bring one back">
          {showDone ? "Hide done" : `Show done (${data?.counts.done ?? 0})`}
        </button>
        <button className="ghost" onClick={onClose} aria-label="close board" title="back to agents (Esc)">
          <IconClose />
        </button>
      </div>
      <div className={`kb-cols n${cols.length}`}>
        {cols.map((col) => {
          const cards = data?.cards.filter((c) => c.col === col) ?? [];
          return (
            <section
              key={col}
              className={`kb-col kb-${col}${drag?.over === col ? " over" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                if (drag && drag.over !== col) setDrag({ ...drag, over: col, before: null });
              }}
              onDrop={(e) => {
                e.preventDefault();
                drop(col);
              }}
              aria-label={LABEL[col]}
            >
              <header>
                <span className={`kb-dot kb-dot-${col}`} />
                {LABEL[col]}
                <span className="kb-n">{col === "done" ? data?.counts.done : cards.length}</span>
              </header>
              {col === "draft" && <QuickAdd onAdd={(title) => act(rpc("cardAdd", { title, project: project || undefined }))} />}
              <div className="kb-cards">
                {cards.map((c) => (
                  <article
                    key={c.id}
                    className={`kb-card${drag?.id === c.id ? " dragging" : ""}${drag && drag.before === c.id && drag.over === col ? " drop-before" : ""}`}
                    draggable
                    tabIndex={0}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", String(c.id));
                      setDrag({ id: c.id });
                    }}
                    onDragEnd={() => setDrag(null)}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (!drag || drag.id === c.id) return;
                      const r = e.currentTarget.getBoundingClientRect();
                      const upper = e.clientY < r.top + r.height / 2;
                      const idx = cards.indexOf(c);
                      const before = upper ? c.id : (cards[idx + 1]?.id ?? null);
                      if (drag.before !== before || drag.over !== col) setDrag({ ...drag, over: col, before });
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      drop(col);
                    }}
                    onClick={() => setEditing(c)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") setEditing(c);
                      // keyboard moves: ← / → between columns
                      const order: Col[] = ["draft", "doing", "done"];
                      const i = order.indexOf(c.col as Col);
                      if (e.key === "ArrowRight" && i < 2) act(rpc("cardMove", { id: c.id, col: order[i + 1] }));
                      if (e.key === "ArrowLeft" && i > 0) act(rpc("cardMove", { id: c.id, col: order[i - 1] }));
                    }}
                  >
                    <div className="kb-title">{c.title}</div>
                    {c.body && <div className="kb-body">{c.body.slice(0, 160)}</div>}
                    {(c.project || c.labels.length > 0 || c.source !== "owner") && (
                      <div className="kb-meta">
                        {c.project && <span className="kb-proj">{c.project}</span>}
                        {c.labels.map((l) => (
                          <span key={l} className="kb-label">
                            {l}
                          </span>
                        ))}
                        {c.source !== "owner" && <span className="kb-src">by {c.source}</span>}
                      </div>
                    )}
                  </article>
                ))}
                {!cards.length && <div className="kb-empty">{col === "draft" ? "Nothing drafted" : col === "doing" ? "Drag a card here when you start it" : "Nothing done yet"}</div>}
              </div>
            </section>
          );
        })}
      </div>
      {editing && <CardEditor card={editing} onClose={() => setEditing(null)} onSaved={load} />}
    </div>
  );
}

function QuickAdd({ onAdd }: { onAdd: (title: string) => void }) {
  const [t, setT] = useState("");
  return (
    <form
      className="kb-add"
      onSubmit={(e) => {
        e.preventDefault();
        if (t.trim()) onAdd(t.trim());
        setT("");
      }}
    >
      <IconPlus size={14} />
      <input value={t} onChange={(e) => setT(e.target.value)} placeholder="Add a card" aria-label="new card title" />
    </form>
  );
}

function CardEditor({ card, onClose, onSaved }: { card: Card; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(card.title);
  const [body, setBody] = useState(card.body);
  const [project, setProject] = useState(card.project);
  const [labels, setLabels] = useState(card.labels.join(", "));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  useOverlay("modal", onClose); // on top of the board: Esc closes only the editor
  const save = async () => {
    await rpc("cardUpdate", { id: card.id, title, body, project, labels: labels.split(",") });
    onSaved();
    onClose();
  };
  const agents = store.layout.panes.map((p) => p.name);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal kb-editor"
        role="dialog"
        aria-label={`card #${card.id}`}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void save();
        }}
      >
        <input ref={ref} className="kb-edit-title" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="title" />
        <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Notes, links, acceptance criteria…" rows={8} aria-label="notes" />
        <div className="kb-edit-row">
          <label>
            Project <input value={project} onChange={(e) => setProject(e.target.value)} placeholder="e.g. acme-api" />
          </label>
          <label>
            Labels <input value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="comma separated" />
          </label>
        </div>
        <div className="kb-edit-foot">
          <span className="dim small">
            #{card.id} · {card.source} · {new Date(card.created).toLocaleDateString()}
          </span>
          <span className="spacer" />
          {agents.length > 0 && (
            <select
              value=""
              onChange={(e) => {
                const to = e.target.value;
                if (!to) return;
                void rpc("prompt", { name: to, text: `Card #${card.id}: ${title}\n\n${body}`.trim() })
                  .then(() => rpc("cardMove", { id: card.id, col: "doing" }))
                  .then(() => {
                    store.toast(`sent to ${to}; card moved to In progress`);
                    onSaved();
                    onClose();
                    setTimeout(() => focus.to(to), 0);
                  })
                  .catch((err) => store.toast(err.message, "error"));
              }}
              aria-label="send to agent"
            >
              <option value="">Send to agent…</option>
              {agents.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          )}
          <button
            className="ghost danger"
            onClick={() => {
              if (confirm(`Delete card #${card.id}?`)) void rpc("cardRemove", { id: card.id }).then(() => (onSaved(), onClose()));
            }}
          >
            Delete
          </button>
          <button className="primary" onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
