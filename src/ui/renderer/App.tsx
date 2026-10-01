import { useEffect, useMemo, useRef, useState } from "react";
import type { JobView, Layout, PaneSpec, Policy, WorktreeView } from "../protocol.js";
import { connect, hello, onEvent, onFocusLast, rpc } from "./bridge.js";
import { ping, store, useStore } from "./store.js";
import { Pane } from "./Pane.js";
import { Drawer } from "./Drawer.js";
import { agentNameProblem } from "../../core/names.js";
import { GroupChat, GroupsSection, LinkDialog } from "./Links.js";
import { RecipesDialog, SkillsDialog } from "./Extras.js";
import { focus } from "./focus.js";
import { ctxPct, fmtIdle, parseDuration, statusLabel, suggestName } from "./format.js";

const POLICIES: Policy[] = ["ask", "allow-reads", "allow-all", "reject-all"];

function saveLayout(patch: Partial<Layout>) {
  store.layout = { ...store.layout, ...patch };
  store.changed();
  void rpc("saveLayout", store.layout);
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

/** Pull the backend's full state and (re)open every pane in the layout. */
let syncing: Promise<void> | undefined;
function sync() {
  syncing ??= (async () => {
    try {
      const st = await rpc("getState", {});
      store.applyState(st);
      for (const p of store.layout.panes) void openPane(p, false);
    } catch (e: any) {
      store.toast(`could not load hive state: ${e.message}`, "error");
    } finally {
      syncing = undefined;
    }
  })();
  return syncing;
}

/** An agent not on screen needs the user (e.g. a job's permission ask): give it a pane. */
function adoptPane(name: string) {
  if (store.layout.panes.some((p) => p.name === name)) return;
  const a = store.agents.get(name);
  if (!a) return;
  saveLayout({ panes: [...store.layout.panes, { name, kind: a.kind, cwd: a.cwd, role: a.role, policy: a.policy }] });
  store.toast(`${name} needs you — opened its pane`);
}

let booted = false;
function boot() {
  if (booted) return;
  booted = true;
  onEvent((ev) => {
    store.apply(ev);
    if (ev.event === "ready") void sync(); // backend (re)started
    if (ev.event === "permission" || ev.event === "elicitation") adoptPane(ev.ask.agent);
  });
  connect();
  // Renderer reload with the backend already running: fetch state now.
  void hello().then((up) => {
    if (up) void sync();
  });
  onFocusLast(() => focus.last());
}

export function App() {
  useEffect(boot, []);
  const ready = useStore((s) => s.ready);
  const layout = useStore((s) => s.layout);
  const toasts = useStore((s) => s.toasts);
  const [adding, setAdding] = useState(false);
  const [jobFor, setJobFor] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<false | "default" | "usage">(false);
  const [dialog, setDialog] = useState<"" | "recipes" | "skills">("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const skillReq = useStore((s) => s.skillRequest);
  const linkReq = useStore((s) => s.linkRequest);
  const groupOpen = useStore((s) => s.groupOpen);

  const names = layout.panes.map((p) => p.name);
  const visible = layout.maximized && names.includes(layout.maximized) ? [layout.maximized] : names;
  useEffect(() => focus.setOrder(names), [names.join("|")]);

  // Title shows how many agents need you, so it's visible from the taskbar.
  const waitingTotal = useStore((s) => names.reduce((n, x) => n + s.waitingOn(x), 0));
  const readyTotal = useStore((s) => names.filter((n) => s.readyAt.has(n)).length);
  useEffect(() => {
    document.title = waitingTotal ? `(${waitingTotal}) hive — needs you` : readyTotal ? `✓${readyTotal} hive — ready` : "hive";
  }, [waitingTotal, readyTotal]);

  // 9:16 monitors: tall or narrow windows get one column and no sidebar (unless you choose otherwise).
  const portrait = useMedia("(max-aspect-ratio: 4/5), (max-width: 820px)");
  const orientation = layout.orientation ?? "auto";
  const vertical = orientation === "vertical" || (orientation === "auto" && portrait);
  const sidebar = vertical ? !!layout.vsidebar : layout.sidebar;
  const columns = vertical ? (layout.vcolumns ?? 1) : layout.columns;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        const i = Number(e.key) - 1;
        if (layout.maximized && layout.maximized !== names[i]) {
          saveLayout({ maximized: null });
          // the target pane mounts on the next frame
          requestAnimationFrame(() => requestAnimationFrame(() => focus.nth(i)));
        } else focus.nth(i);
      } else if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        focus.cycle(e.shiftKey ? -1 : 1);
      } else if (mod && e.key.toLowerCase() === "n" && !e.shiftKey) {
        e.preventDefault();
        setAdding(true);
      } else if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        document.querySelector<HTMLInputElement>(".broadcast input")?.focus();
      } else if (mod && e.key === "\\") {
        e.preventDefault();
        toggleSidebar();
      } else if (mod && (e.key === "=" || e.key === "+" || e.key === "-" || e.key === "0")) {
        e.preventDefault();
        const z = store.layout.zoom ?? 1;
        const next = e.key === "0" ? 1 : Math.min(2, Math.max(0.6, Math.round((z + (e.key === "-" ? -0.1 : 0.1)) * 10) / 10));
        saveLayout({ zoom: next });
      } else if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setDialog("skills");
      } else if (mod && e.key.toLowerCase() === "i") {
        e.preventDefault();
        setDrawer((d) => (d ? false : "default"));
      } else if (mod && e.key.toLowerCase() === "m") {
        e.preventDefault();
        const a = focus.active;
        if (a) saveLayout({ maximized: store.layout.maximized === a ? null : a });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [layout.maximized]);

  useEffect(() => {
    (document.documentElement.style as any).zoom = String(layout.zoom ?? 1);
  }, [layout.zoom]);

  if (!ready) return <div className="boot">starting hive…</div>;

  return (
    <div className={`app${sidebar ? "" : " nosidebar"}${vertical ? " vertical" : ""}`}>
      <TopBar
        names={names}
        selected={selected}
        setSelected={setSelected}
        onAdd={() => setAdding(true)}
        onHive={() => setDrawer(drawer ? false : "default")}
        onUsage={() => setDrawer(drawer === "usage" ? false : "usage")}
        onRecipes={() => setDialog("recipes")}
        onSkills={() => setDialog("skills")}
        vertical={vertical}
        columns={columns}
      />
      {sidebar && <Sidebar names={names} onAdd={() => setAdding(true)} />}
      <main className="grid-wrap">
        {names.length === 0 ? (
          <div className="welcome">
            <h1>hive</h1>
            <p>Run Claude Code, Codex, Qwen and friends side by side. They can message each other through the hive.</p>
            <div className="welcome-actions">
              <button className="primary" onClick={() => setAdding(true)}>+ Add an agent</button>
              <button onClick={() => setDialog("recipes")}>⚡ Set up a team (recipe)</button>
              <button onClick={() => setDialog("skills")}>✦ Run a skill</button>
            </div>
            <p className="dim">
              Ctrl+N add · Ctrl+1..9 jump · Ctrl+Tab cycle · Ctrl+B broadcast · Ctrl+I hive report &amp; mail · Ctrl+M maximize · Ctrl+= / Ctrl+- zoom · Ctrl+\ sidebar · hover a pane to type into it
            </p>
          </div>
        ) : (
          <Grid names={visible} columns={layout.maximized ? 1 : columns} widths={layout.maximized || vertical ? undefined : layout.widths} minRow={vertical ? 360 : 220}>
            {visible.map((n) => (
              <Pane
                key={n}
                name={n}
                index={names.indexOf(n)}
                onMaximize={() => saveLayout({ maximized: layout.maximized === n ? null : n })}
                onJob={() => setJobFor(n)}
                selected={selected.has(n)}
                onSelect={(v) => {
                  const s = new Set(selected);
                  if (v) s.add(n);
                  else s.delete(n);
                  setSelected(s);
                }}
              />
            ))}
          </Grid>
        )}
      </main>
      {adding && <AddAgentDialog onClose={() => setAdding(false)} />}
      {jobFor && <JobDialog agent={jobFor} onClose={() => setJobFor(null)} />}
      {drawer && <Drawer key={drawer} initialTab={drawer === "usage" ? "usage" : undefined} onClose={() => setDrawer(false)} />}
      {dialog === "recipes" && <RecipesDialog onClose={() => setDialog("")} />}
      {linkReq && (
        <LinkDialog
          members={linkReq}
          onClose={() => {
            store.linkRequest = null;
            store.changed();
          }}
        />
      )}
      {groupOpen && <GroupChat key={groupOpen} name={groupOpen} onClose={() => store.openGroup(null)} />}
      {(dialog === "skills" || skillReq) && (
        <SkillsDialog
          key={skillReq ? `req-${skillReq.name}` : "skills"}
          initial={skillReq}
          onClose={() => {
            setDialog("");
            store.skillRequest = null;
            store.changed();
          }}
        />
      )}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.level}`}>{t.text}</div>
        ))}
      </div>
    </div>
  );
}

function useMedia(q: string): boolean {
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const f = () => setM(mq.matches);
    mq.addEventListener("change", f);
    return () => mq.removeEventListener("change", f);
  }, [q]);
  return m;
}

/** The sidebar switch remembers its state separately for the vertical layout. */
function toggleSidebar() {
  const vertical = document.querySelector(".app")?.classList.contains("vertical");
  if (vertical) saveLayout({ vsidebar: !store.layout.vsidebar });
  else saveLayout({ sidebar: !store.layout.sidebar });
}

// ---- top bar: broadcast + layout controls ----

function TopBar({ names, selected, setSelected, onAdd, onHive, onUsage, onRecipes, onSkills, vertical, columns }: {
  onUsage: () => void;
  vertical: boolean;
  columns: number;
  names: string[];
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  onAdd: () => void;
  onHive: () => void;
  onRecipes: () => void;
  onSkills: () => void;
}) {
  const unread = useStore((s) => s.ownerUnread);
  const layout = useStore((s) => s.layout);
  const [text, setText] = useState("");
  const targets = names.filter((n) => selected.has(n) && store.agents.has(n));
  const send = () => {
    const t = text.trim();
    if (!t) return;
    const to = targets.length ? targets : names.filter((n) => store.agents.has(n));
    if (!to.length) return store.toast("no running agents to broadcast to", "error");
    void rpc("broadcast", { names: to, text: t });
    store.toast(`sent to ${to.join(", ")}`);
    setText("");
  };
  const cols = columns;
  const setCols = (n: number) => saveLayout(vertical ? { vcolumns: n } : { columns: n, widths: undefined });
  const readyNames = useStore((s) => names.filter((n) => s.readyAt.has(n)));
  const orient = layout.orientation ?? "auto";
  const nextOrient = orient === "auto" ? "vertical" : orient === "vertical" ? "horizontal" : "auto";
  return (
    <div className="topbar">
      <button className="ghost" onClick={toggleSidebar} title="toggle sidebar (Ctrl+\)" aria-label="toggle sidebar">☰</button>
      <span className="brand">hive</span>
      <div className="broadcast">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder={
            targets.length ? `broadcast to ${targets.join(", ")}…` : `broadcast to all ${names.length} agents… (tick pane boxes to pick)`
          }
        />
        <button onClick={send} disabled={!text.trim()}>Send</button>
        {selected.size > 0 && (
          <button className="ghost" onClick={() => setSelected(new Set())} title="clear selection">
            ✕ {selected.size}
          </button>
        )}
      </div>
      <span className="spacer" />
      {readyNames.length > 0 && (
        <button
          className="ready-btn"
          onClick={() => {
            const n = readyNames[0];
            if (layout.maximized && layout.maximized !== n) saveLayout({ maximized: null });
            setTimeout(() => focus.to(n), 0);
          }}
          title={`finished: ${readyNames.join(", ")} — click to jump to the next one`}
        >
          ✓ {readyNames.length} ready
        </button>
      )}
      <button
        className="ghost"
        onClick={() => saveLayout({ orientation: nextOrient })}
        title={`layout: ${orient}${orient === "auto" ? ` (now ${vertical ? "vertical" : "horizontal"})` : ""} — click for ${nextOrient}. Auto goes vertical on tall/narrow windows (9:16 monitors).`}
        aria-label={`layout ${orient}`}
      >
        {orient === "auto" ? (vertical ? "▯ auto" : "▭ auto") : orient === "vertical" ? "▯ vertical" : "▭ horizontal"}
      </button>
      <button
        className="ghost"
        onClick={() => {
          saveLayout({ ping: layout.ping === false });
          if (layout.ping === false) ping();
        }}
        title={layout.ping === false ? "sound off — click to chime when an agent finishes" : "chime when an agent finishes (click to mute)"}
        aria-label={layout.ping === false ? "finish sound off" : "finish sound on"}
      >
        {layout.ping === false ? "🔕" : "🔔"}
      </button>
      <label className="toggle" title="hovering a pane focuses its input (for Handy / voice typing)">
        <input type="checkbox" checked={layout.hoverFocus} onChange={(e) => saveLayout({ hoverFocus: e.target.checked })} /> hover focus
      </label>
      <span className="cols" title="panes per row">
        <button className="ghost" disabled={cols <= 1} onClick={() => setCols(cols - 1)} aria-label="fewer columns">−</button>
        {cols} cols
        <button className="ghost" disabled={cols >= 8} onClick={() => setCols(cols + 1)} aria-label="more columns">+</button>
      </span>
      <UsageChip onClick={onUsage} />
      <button className="ghost" onClick={onSkills} title="reusable prompts with parameters (Ctrl+K)">
        ✦ Skills
      </button>
      <button className="ghost" onClick={onRecipes} title="set up a ready-made team of agents">
        ⚡ Recipes
      </button>
      <button className={`hive-btn${unread ? " has-mail" : ""}`} onClick={onHive} title="report, inbox, blackboard, mail (Ctrl+I)">
        ✉ Hive{unread ? <span className="badge alert">{unread}</span> : null}
      </button>
      <button className="primary" onClick={onAdd} title="add agent (Ctrl+N)">+ Agent</button>
    </div>
  );
}

/** Fullest subscription window across providers; amber/red as it fills, ⏸ when automatic work is held. */
function UsageChip({ onClick }: { onClick: () => void }) {
  const [u, setU] = useState<Awaited<ReturnType<typeof rpc<"usage">>> | null>(null);
  useEffect(() => {
    const load = () => void rpc("usage", {}).then(setU).catch(() => {});
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);
  if (!u) return null;
  let worst: { p: string; w: string; pct: number } | null = null;
  for (const p of u.providers)
    for (const l of p.limits) {
      const pct = l.status === "rejected" ? 100 : (l.pct ?? -1);
      if (pct >= 0 && (!worst || pct > worst.pct)) worst = { p: p.provider, w: l.window, pct };
    }
  const held = u.budget.paused === "1" || u.providers.some((p) => !p.guard.ok);
  const lvl = held || (worst?.pct ?? 0) >= 90 ? "err" : (worst?.pct ?? 0) >= 70 ? "warn" : "";
  return (
    <button className={`ghost usage-chip ${lvl}`} onClick={onClick} title="usage, limits and spending guards">
      {held ? "⏸ " : ""}
      {worst ? `${worst.p} ${Math.max(0, 100 - Math.round(worst.pct))}% left` : "Usage"}
    </button>
  );
}

// ---- resizable grid ----

function Grid({ names, columns, widths, minRow, children }: { names: string[]; columns: number; widths?: number[]; minRow: number; children: React.ReactNode }) {
  const cols = Math.max(1, Math.min(columns, names.length));
  const w = widths && widths.length === cols ? widths : Array(cols).fill(1);
  const rows = Math.ceil(names.length / cols);
  const ref = useRef<HTMLDivElement>(null);
  const total = w.reduce((a, b) => a + b, 0);
  const startDrag = (i: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    const el = ref.current!;
    const rect = el.getBoundingClientRect();
    const start = [...w];
    const x0 = e.clientX;
    const move = (ev: PointerEvent) => {
      const dfr = ((ev.clientX - x0) / rect.width) * total;
      const next = [...start];
      const min = total * 0.08;
      const a = Math.max(min, start[i] + dfr);
      const b = Math.max(min, start[i] + start[i + 1] - a);
      next[i] = start[i] + start[i + 1] - b;
      next[i + 1] = b;
      store.layout = { ...store.layout, widths: next };
      store.changed();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      void rpc("saveLayout", store.layout);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  let acc = 0;
  return (
    <div
      className="grid"
      ref={ref}
      style={{ gridTemplateColumns: w.map((x) => `minmax(0, ${x}fr)`).join(" "), gridTemplateRows: `repeat(${rows}, minmax(${minRow}px, 1fr))` }}
    >
      {children}
      {w.slice(0, -1).map((x, i) => {
        acc += x;
        return (
          <div
            key={i}
            className="col-handle"
            style={{ left: `calc(${(acc / total) * 100}% - 4px)` }}
            onPointerDown={startDrag(i)}
            onDoubleClick={() => saveLayout({ widths: undefined })}
            title="drag to resize · double-click to reset"
          />
        );
      })}
    </div>
  );
}

// ---- sidebar ----

function Sidebar({ names, onAdd }: { names: string[]; onAdd: () => void }) {
  const agents = useStore((s) => s.agents);
  const starting = useStore((s) => s.starting);
  const jobs = useStore((s) => s.jobs);
  const layout = useStore((s) => s.layout);
  const active = jobs.filter((j) => j.state === "active" || j.state === "queued");
  const [runsFor, setRunsFor] = useState<JobView | null>(null);
  const ended = jobs.filter((j) => !(j.state === "active" || j.state === "queued")).slice(-5).reverse();
  return (
    <aside className="sidebar">
      <div className="side-head">
        <span>Agents</span>
        <button className="ghost" onClick={onAdd} title="add agent">＋</button>
      </div>
      <ul className="agent-list">
        {names.map((n, i) => {
          const a = agents.get(n);
          const st = starting.get(n);
          const status = a?.status ?? (st?.error ? "error" : "starting");
          const model = a?.config.find((c) => c.category === "model" || c.id === "model");
          const effort = a?.config.find((c) => c.category === "thought_level" || /effort|reason|think/i.test(c.id));
          const waiting = store.waitingOn(n);
          return (
            <li
              key={n}
              className={`agent-item${layout.maximized === n ? " max" : ""}${store.readyAt.has(n) ? " ready" : ""}`}
              onClick={() => {
                if (layout.maximized && layout.maximized !== n) saveLayout({ maximized: null });
                setTimeout(() => focus.to(n), 0);
              }}
            >
              <div className="row1">
                <span className={`dot ${status}`} title={statusLabel(status)} />
                <strong>{n}</strong>
                <span className="kind">{a?.kind ?? st?.kind}</span>
                <span className="spacer" />
                {waiting > 0 && <span className="badge alert" title="waiting for your answer">!</span>}
                {!waiting && store.readyAt.has(n) && <span className="badge ready" title="finished; not looked at yet">✓</span>}
                {a && a.unread > 0 && <span className="badge" title="unread hive mail">✉{a.unread}</span>}
                {i < 9 && <span className="key">^{i + 1}</span>}
              </div>
              <div className="row2">
                {model && <span>{labelOf(model)}</span>}
                {effort && effort !== model && <span>· {labelOf(effort)}</span>}
                {a && <span className="dim">· {a.status === "idle" ? `idle ${fmtIdle(a.idleMs)}` : statusLabel(a.status)}</span>}
                {a?.ctx && <span className="dim">· {ctxPct(a.ctx.used, a.ctx.size)}% ctx</span>}
              </div>
              {a?.note && <div className="row3" title={a.note}>{a.note}</div>}
              {st?.error && <div className="row3 err">{st.error}</div>}
            </li>
          );
        })}
        {names.length === 0 && <li className="dim pad">no agents yet</li>}
      </ul>
      <GroupsSection />
      <OtherAgents names={names} />
      <Worktrees />
      <div className="side-head">
        <span>Jobs</span>
      </div>
      <ul className="job-list">
        {active.map((j) => (
          <li key={j.id} title={j.prompt} className="clickable" onClick={() => setRunsFor(j)}>
            <div className="row1">
              <span className={`dot ${j.state === "active" ? "working" : "idle"}`} />
              <strong>#{j.id}</strong> <span className="kind">{j.kind}</span> <span>{j.agent}</span>
              <span className="spacer" />
              <button
                className="ghost small"
                onClick={(e) => {
                  e.stopPropagation();
                  void rpc("stopJob", { id: j.id });
                }}
                title="stop job"
              >
                ■
              </button>
            </div>
            <div className="row2 dim">{j.schedule} · {j.runs} run{j.runs === 1 ? "" : "s"}</div>
            {j.lastError && <div className="row3 err">{j.lastError}</div>}
          </li>
        ))}
        {ended.map((j) => (
          <li key={j.id} className="ended clickable" title={j.prompt} onClick={() => setRunsFor(j)}>
            <div className="row1 dim">
              #{j.id} {j.kind} {j.agent} — {j.state} · {j.runs} run{j.runs === 1 ? "" : "s"}
            </div>
          </li>
        ))}
        {jobs.length === 0 && <li className="dim pad">none — use ⏱ on a pane</li>}
      </ul>
      {runsFor && <JobRunsDialog job={runsFor} onClose={() => setRunsFor(null)} />}
    </aside>
  );
}

function OtherAgents({ names }: { names: string[] }) {
  const others = useStore((s) => s.others).filter((o) => !names.includes(o.name));
  if (!others.length) return null;
  return (
    <>
      <div className="side-head">
        <span>Other agents in this hive</span>
      </div>
      <ul className="job-list">
        {others.map((o) => (
          <li key={o.name} title={`${o.cwd}${o.where ? ` — running in ${o.where}` : ""}`}>
            <div className="row1">
              <span className={`dot ${o.status}`} />
              <strong>{o.name}</strong>
              <span className="kind">{o.kind}</span>
              {o.unread > 0 && <span className="badge" title="unread hive mail">✉{o.unread}</span>}
              <span className="spacer" />
              {o.where ? (
                <span className="dim small">elsewhere</span>
              ) : (
                <button
                  className="ghost small"
                  title="open a pane (resumes its session)"
                  onClick={() => void openPane({ name: o.name, kind: o.kind, cwd: o.cwd, role: o.role, policy: (o.policy as Policy) ?? "ask" })}
                >
                  open
                </button>
              )}
            </div>
            {(o.note || o.role) && <div className="row2 dim">{[o.role, o.note].filter(Boolean).join(" · ").slice(0, 80)}</div>}
          </li>
        ))}
      </ul>
    </>
  );
}

function Worktrees() {
  const [repos, setRepos] = useState<{ repo: string; base: string; worktrees: WorktreeView[] }[]>([]);
  const [busy, setBusy] = useState("");
  const refresh = () => void rpc("worktrees", {}).then(setRepos).catch(() => setRepos([]));
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 8000);
    return () => clearInterval(t);
  }, []);
  if (!repos.length) return null;
  const merge = async (repo: string, base: string, w: WorktreeView) => {
    if (!confirm(`Merge ${w.branch} (${w.ahead} commit${w.ahead === 1 ? "" : "s"}, +${w.insertions} −${w.deletions}) into ${base}?`)) return;
    setBusy(w.name);
    try {
      const r = await rpc("mergeWorktree", { name: w.name, repo });
      store.toast(r.message.split("\n")[0], r.ok ? "info" : "error");
    } catch (e: any) {
      store.toast(e.message, "error");
    }
    setBusy("");
    refresh();
  };
  return (
    <>
      <div className="side-head">
        <span>Worktrees</span>
        <button className="ghost" onClick={refresh} title="refresh">↻</button>
      </div>
      <ul className="job-list wt-list">
        {repos.flatMap(({ repo, base, worktrees }) =>
          worktrees.map((w) => (
            <li key={repo + w.name} title={`${w.branch} → ${base} in ${repo}`}>
              <div className="row1">
                <strong>{w.name}</strong>
                <span className="dim">
                  {w.ahead ? `↑${w.ahead}` : ""} {w.behind ? `↓${w.behind}` : ""}
                </span>
                <span className="spacer" />
                <button
                  className="ghost small"
                  disabled={!w.ahead || busy === w.name}
                  onClick={() => void merge(repo, base, w)}
                  title={`merge ${w.branch} into ${base}`}
                >
                  merge
                </button>
              </div>
              <div className="row2 dim">
                → {base} · {w.ahead ? `${w.files} files +${w.insertions} −${w.deletions}` : w.behind ? "nothing new (merged or behind)" : "no commits yet"}
                {w.dirty ? <span className="warn"> · {w.dirty} uncommitted</span> : null}
              </div>
            </li>
          )),
        )}
      </ul>
    </>
  );
}

function JobRunsDialog({ job, onClose }: { job: JobView; onClose: () => void }) {
  const [runs, setRuns] = useState<Awaited<ReturnType<typeof rpc<"jobRuns">>> | null>(null);
  useEffect(() => {
    void rpc("jobRuns", { id: job.id }).then(setRuns).catch((e) => store.toast(e.message, "error"));
  }, [job.id]);
  return (
    <Modal title={`Job #${job.id} · ${job.kind} on ${job.agent}`} onClose={onClose}>
      <div className="dim small">{job.schedule} · {job.state} · {job.runs} run{job.runs === 1 ? "" : "s"}</div>
      <pre className="rep-sum">{job.prompt}</pre>
      <div className="runs">
        {!runs && <div className="dim">loading…</div>}
        {runs?.length === 0 && <div className="dim">no runs yet</div>}
        {runs?.map((r) => (
          <div key={r.iteration + ":" + r.started} className="rep-job">
            <div>
              <strong>run {r.iteration}</strong> <span className="dim">{new Date(r.started).toLocaleString()}</span>{" "}
              <span className={r.error ? "err" : r.stop_reason === "rate_limited" ? "warn" : "ok"}>{r.stop_reason ?? "running"}</span>
              {r.ended ? <span className="dim"> · {Math.round((r.ended - r.started) / 1000)}s</span> : null}
              {r.tokens ? <span className="dim"> · {r.tokens.toLocaleString()} tok</span> : null}
            </div>
            {r.summary && <pre className="rep-sum">{r.summary.slice(-1500)}</pre>}
            {r.error && <div className="err small">{r.error.slice(0, 400)}</div>}
          </div>
        ))}
      </div>
      <div className="buttons">
        {(job.state === "active" || job.state === "queued") && (
          <button className="ghost" onClick={() => void rpc("stopJob", { id: job.id }).then(onClose)}>Stop job</button>
        )}
        <button className="primary" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

function labelOf(o: { currentValue: string | boolean; options?: { value: string; name: string }[] }) {
  return o.options?.find((x) => x.value === o.currentValue)?.name ?? String(o.currentValue);
}

// ---- dialogs ----

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

function AddAgentDialog({ onClose }: { onClose: () => void }) {
  const kinds = useStore((s) => s.kinds);
  const taken = useMemo(() => new Set(store.layout.panes.map((p) => p.name)), []);
  const [kind, setKind] = useState(kinds.find((k) => k.id === "claude")?.id ?? kinds[0]?.id ?? "");
  const [name, setName] = useState(() => suggestName(taken));
  const [cwd, setCwd] = useState(store.layout.panes.at(-1)?.cwd ?? store.cwd);
  const presets = useStore((s) => s.presets);
  const [presetId, setPresetId] = useState("");
  const [role, setRole] = useState("");
  const [policy, setPolicy] = useState<Policy>("ask");
  const [worktree, setWorktree] = useState(false);
  const [startJob, setStartJob] = useState(true);
  const [err, setErr] = useState("");
  const preset = presets.find((p) => p.id === presetId);
  const pickPreset = (id: string) => {
    setPresetId(id);
    const p = presets.find((x) => x.id === id);
    if (!p) return;
    setRole(p.role);
    setPolicy(p.policy);
    setWorktree(p.worktree);
  };
  const submit = () => {
    const n = name.trim();
    const problem = agentNameProblem(n);
    if (problem) return setErr(`name: ${problem}`);
    if (taken.has(n)) return setErr(`"${n}" is already open`);
    onClose();
    void openPane(
      { name: n, kind, cwd: cwd.trim() || store.cwd, role: role.trim(), policy, worktree, preset: presetId || undefined },
      true,
      !!preset?.job && startJob,
    );
    setTimeout(() => focus.to(n), 300);
  };
  return (
    <Modal title="Add agent" onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label>
          <span>Agent</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)} autoFocus>
            {kinds.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
                {k.missing ? ` (set ${k.missing})` : ""}
              </option>
            ))}
          </select>
        </label>
        {(() => {
          const k = kinds.find((x) => x.id === kind);
          if (!k?.missing && !k?.api) return null;
          return (
            <div className={`hint small ${k.missing ? "warn" : "dim"}`}>
              {k.missing ? `${k.missing} is not set. ` : "Billed per token to your API key. "}
              {k.install}
            </div>
          );
        })()}
        <label>
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          <span>Folder</span>
          <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder={store.cwd} />
        </label>
        <label>
          <span>Preset</span>
          <select value={presetId} onChange={(e) => pickPreset(e.target.value)}>
            <option value="">— none —</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
                {p.job ? ` · ${p.job}` : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Role</span>
          <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="coder, reviewer, security watcher… (shown to other agents)" />
        </label>
        <label>
          <span>Permissions</span>
          <select value={policy} onChange={(e) => setPolicy(e.target.value as Policy)}>
            {POLICIES.map((p) => (
              <option key={p} value={p}>
                {p}
                {p === "ask" ? " — ask me in the pane" : p === "allow-reads" ? " — auto-allow reads, ask for edits" : p === "allow-all" ? " — trusted (use a worktree)" : " — read-only"}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Worktree</span>
          <span className="check">
            <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} />
            own git worktree on branch hive/{name || "<name>"} (recommended for agents that edit)
          </span>
        </label>
        {preset?.job && (
          <label>
            <span>Job</span>
            <span className="check">
              <input type="checkbox" checked={startJob} onChange={(e) => setStartJob(e.target.checked)} />
              also start the preset's job ({preset.job})
            </span>
          </label>
        )}
        {err && <div className="err">{err}</div>}
        <div className="buttons">
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary">Add</button>
        </div>
      </form>
    </Modal>
  );
}

function JobDialog({ agent, onClose }: { agent: string; onClose: () => void }) {
  const [kind, setKind] = useState<"loop" | "interval" | "watch" | "once">("loop");
  const [prompt, setPrompt] = useState("");
  const [times, setTimes] = useState("5");
  const [forS, setForS] = useState("");
  const [every, setEvery] = useState("10m");
  const [path, setPath] = useState(".");
  const [minLines, setMinLines] = useState("50");
  const [maxWait, setMaxWait] = useState("");
  const [cooldown, setCooldown] = useState("");
  const [err, setErr] = useState("");
  const submit = async () => {
    if (!prompt.trim()) return setErr("write the instruction the agent should run");
    const p: Parameters<typeof rpc<"addJob">>[1] = { agent, kind, prompt: prompt.trim() };
    if (kind === "loop") {
      if (times.trim()) p.times = Number(times);
      if (forS.trim()) {
        const ms = parseDuration(forS);
        if (!ms) return setErr(`bad duration "${forS}" (e.g. 8h, 90m)`);
        p.forMs = ms;
      }
      if (!p.times && !p.forMs) return setErr("set times and/or a duration");
    } else if (kind === "interval") {
      const ms = parseDuration(every);
      if (!ms) return setErr(`bad interval "${every}" (e.g. 10m)`);
      p.everyMs = ms;
    } else if (kind === "watch") {
      p.watchPath = path.trim() || ".";
      p.minLines = Number(minLines) || (p.watchPath.startsWith("@bb:") ? 1 : 50);
      if (maxWait.trim()) {
        const ms = parseDuration(maxWait);
        if (!ms) return setErr(`bad duration "${maxWait}" (e.g. 30m)`);
        p.maxWaitMs = ms;
      }
      if (cooldown.trim()) {
        const ms = parseDuration(cooldown);
        if (!ms) return setErr(`bad duration "${cooldown}" (e.g. 10m)`);
        p.cooldownMs = ms;
      }
    }
    try {
      const id = await rpc("addJob", p);
      store.toast(`job #${id} scheduled on ${agent}`);
      onClose();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  return (
    <Modal title={`Schedule a job on ${agent}`} onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="seg">
          {(["loop", "interval", "watch", "once"] as const).map((k) => (
            <button type="button" key={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
              {k === "interval" ? "every" : k}
            </button>
          ))}
        </div>
        <p className="dim small">
          {kind === "loop" && "Runs back to back, each time in a fresh session. A notes file carries findings between runs."}
          {kind === "interval" && "Runs on a timer, each time in a fresh session."}
          {kind === "watch" && "Runs when enough lines change under the folder (untracked files count; .git, node_modules, .hive ignored)."}
          {kind === "once" && "Runs once now in a fresh session."}
          {" "}Each run starts a new conversation on this agent.
        </p>
        <label>
          <span>Instruction</span>
          <textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} autoFocus placeholder="e.g. hunt for bugs in src/ and fix one per run" />
        </label>
        {kind === "loop" && (
          <>
            <label>
              <span>Times</span>
              <input value={times} onChange={(e) => setTimes(e.target.value)} placeholder="5" />
            </label>
            <label>
              <span>For</span>
              <input value={forS} onChange={(e) => setForS(e.target.value)} placeholder="8h (optional)" />
            </label>
          </>
        )}
        {kind === "interval" && (
          <label>
            <span>Every</span>
            <input value={every} onChange={(e) => setEvery(e.target.value)} placeholder="10m" />
          </label>
        )}
        {kind === "watch" && (
          <>
            <label>
              <span>Watch</span>
              <select
                value={path === "@branches" ? "@branches" : path.startsWith("@bb:") ? "@bb" : "path"}
                onChange={(e) => {
                  const v = e.target.value;
                  setPath(v === "@branches" ? "@branches" : v === "@bb" ? "@bb:ideas/raw/" : ".");
                  setMinLines(v === "@bb" ? "1" : "50");
                }}
              >
                <option value="path">a folder (changed lines)</option>
                <option value="@branches">agents' branches (hive/*) — commits by coders in worktrees</option>
                <option value="@bb">blackboard entries (new items under a prefix)</option>
              </select>
            </label>
            {path.startsWith("@bb:") && (
              <label>
                <span>Prefix</span>
                <input value={path.slice(4)} onChange={(e) => setPath("@bb:" + e.target.value)} placeholder="ideas/raw/" />
              </label>
            )}
            {path !== "@branches" && !path.startsWith("@bb:") && (
              <label>
                <span>Path</span>
                <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="relative to the agent's folder" />
              </label>
            )}
            <label>
              <span>{path.startsWith("@bb:") ? "Min entries" : "Min lines"}</span>
              <input value={minLines} onChange={(e) => setMinLines(e.target.value)} />
            </label>
            <label>
              <span>Max wait</span>
              <input value={maxWait} onChange={(e) => setMaxWait(e.target.value)} placeholder="e.g. 30m — review any change after this long" />
            </label>
            <label>
              <span>Cooldown</span>
              <input value={cooldown} onChange={(e) => setCooldown(e.target.value)} placeholder="e.g. 10m — at most one review per" />
            </label>
          </>
        )}
        {err && <div className="err">{err}</div>}
        <div className="buttons">
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary">Schedule</button>
        </div>
      </form>
    </Modal>
  );
}
