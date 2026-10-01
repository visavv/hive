import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { JobView, Layout, PaneSpec, Policy, WorktreeView } from "../protocol.js";
import { connect, hello, onEvent, onFocusLast, rpc } from "./bridge.js";
import { ping, store, useStore } from "./store.js";
import { Pane } from "./Pane.js";
import { Drawer } from "./Drawer.js";
import { agentNameProblem } from "../../core/names.js";
import { GroupChat, GroupsSection, LinkDialog, PauseIcon } from "./Links.js";
import { VerdictWindow } from "./Verdict.js";
import { StatsDialog } from "./Stats.js";
import { KanbanView } from "./Kanban.js";
import { CodeHost, codeActions, openCode } from "./Code.js";

export const THEMES: { id: NonNullable<Layout["theme"]>; label: string; hint: string; tone: "dark" | "light" }[] = [
  { id: "dark", label: "Dark", hint: "neutral grays, periwinkle accent", tone: "dark" },
  { id: "oled", label: "OLED black", hint: "true black, pixels off", tone: "dark" },
  { id: "midnight", label: "Midnight", hint: "deep navy, cyan", tone: "dark" },
  { id: "forest", label: "Forest", hint: "green-black, mint", tone: "dark" },
  { id: "ember", label: "Ember", hint: "warm charcoal, orange", tone: "dark" },
  { id: "rose", label: "Rosé", hint: "plum, soft pink", tone: "dark" },
  { id: "light", label: "Light", hint: "white, indigo", tone: "light" },
  { id: "paper", label: "Paper", hint: "warm sepia, ink blue", tone: "light" },
];
import { Palette, type PaletteAction } from "./Palette.js";
import { agentState, rollup, STATE_LABEL, StatePill } from "./state.js";
import { IconBell, IconBellOff, IconColumns, IconInbox, IconMenu, IconPlus, IconRows, IconScale, IconSearch, IconSpark, IconTeam } from "./Icons.js";
import { RecipesDialog, SkillsDialog } from "./Extras.js";
import { focus, onActivate, overlays, useOverlay } from "./focus.js";
import { ctxPct, fmtIdle, parseDuration, statusLabel, suggestName, noteLabel } from "./format.js";

const POLICIES: Policy[] = ["ask", "allow-reads", "allow-all", "reject-all"];

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
  const [dialog, setDialog] = useState<"" | "recipes" | "skills" | "stats" | "board">("");
  const [palette, setPalette] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const skillReq = useStore((s) => s.skillRequest);
  const linkReq = useStore((s) => s.linkRequest);
  const groupOpen = useStore((s) => s.groupOpen);

  const names = layout.panes.map((p) => p.name);
  const maximized = maxedName(layout);
  const visible = maximized ? [maximized] : names;
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
      // Read the layout now, not from the render this handler was made in.
      const names = store.layout.panes.map((p) => p.name);
      const maximized = maxedName(store.layout);
      // A dialog, the drawer or the palette is open: pane shortcuts would act on
      // what's hidden behind it. Only zoom, and the key that closes the top overlay, pass.
      const top = overlays.top;
      if (top) {
        const zoom = mod && (e.key === "=" || e.key === "+" || e.key === "-" || e.key === "0");
        const k = e.key.toLowerCase();
        const closesTop = mod && !e.shiftKey && ((top === "palette" && k === "k") || (top === "drawer" && k === "i"));
        if (!zoom && !closesTop) return;
      }
      if (mod && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        const i = Number(e.key) - 1;
        if (maximized && maximized !== names[i]) {
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
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        document.querySelector<HTMLInputElement>(".broadcast input")?.focus();
      } else if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
      } else if (mod && e.shiftKey && (e.key === "[" || e.key === "{" || e.key === "]" || e.key === "}")) {
        e.preventDefault();
        focus.cycle(e.key === "[" || e.key === "{" ? -1 : 1);
      } else if (mod && e.key === "\\") {
        e.preventDefault();
        toggleSidebar();
      } else if (mod && (e.key === "=" || e.key === "+" || e.key === "-" || e.key === "0")) {
        e.preventDefault();
        const z = store.layout.zoom ?? 1;
        const next = e.key === "0" ? 1 : Math.min(2, Math.max(0.6, Math.round((z + (e.key === "-" ? -0.1 : 0.1)) * 10) / 10));
        saveLayout({ zoom: next });
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setDialog("skills");
      } else if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((v) => !v);
      } else if (mod && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setDialog((d) => (d === "board" ? "" : "board"));
      } else if (mod && e.key.toLowerCase() === "i") {
        e.preventDefault();
        setDrawer((d) => (d ? false : "default"));
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        openCode({ find: true });
      } else if (mod && e.key.toLowerCase() === "m") {
        e.preventDefault();
        toggleMaximize(focus.active);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    (document.documentElement.style as any).zoom = String(layout.zoom ?? 1);
  }, [layout.zoom]);
  useEffect(() => {
    document.documentElement.dataset.theme = layout.theme ?? "dark";
    document.documentElement.dataset.tone = THEMES.find((t) => t.id === (layout.theme ?? "dark"))?.tone ?? "dark";
    document.documentElement.dataset.density = layout.density ?? "comfortable";
  }, [layout.theme, layout.density]);

  const actions: PaletteAction[] = [
    { id: "new", label: "New agent", keys: "Ctrl+N", run: () => setAdding(true) },
    { id: "team", label: "Set up a team (recipes)", hint: "squad, coder + reviewer, idea pipeline…", run: () => setDialog("recipes") },
    { id: "verdict", label: "Verdict: one prompt, several agents, one judge", run: () => store.openVerdict({}) },
    { id: "skills", label: "Run a skill", hint: "YouTube titles, code review, prompt-engineer…", keys: "Ctrl+Shift+K", run: () => setDialog("skills") },
    { id: "link", label: "Link agents so they can talk", run: () => store.requestLink([]) },
    { id: "inbox", label: "Inbox and messages waiting for review", keys: "Ctrl+I", run: () => setDrawer("default") },
    { id: "usage", label: "Usage, limits and spending guards", run: () => setDrawer("usage") },
    { id: "stats", label: "Token stats: by provider, model, task, project", hint: "all projects, kept for good", run: () => setDialog("stats") },
    { id: "broadcast", label: "Message all agents", keys: "Ctrl+Shift+B", run: () => setTimeout(() => document.querySelector<HTMLInputElement>(".broadcast input")?.focus(), 0) },
    { id: "sidebar", label: "Toggle sidebar", keys: "Ctrl+B", run: () => toggleSidebar() },
    { id: "max", label: "Maximize / restore the focused agent", keys: "Ctrl+M", run: () => toggleMaximize(focus.active) },
    { id: "layout", label: `Layout: ${layout.orientation === "vertical" ? "horizontal" : layout.orientation === "horizontal" ? "auto" : "vertical"} (now ${layout.orientation ?? "auto"})`, run: () => saveLayout({ orientation: layout.orientation === "vertical" ? "horizontal" : layout.orientation === "horizontal" ? "auto" : "vertical" }) },
    { id: "board", label: "Board (Kanban): Draft, In progress, Done", keys: "Ctrl+J", run: () => setDialog("board") },
    ...codeActions(),
    ...THEMES.filter((t) => t.id !== (layout.theme ?? "dark")).map((t) => ({ id: "theme-" + t.id, label: `Theme: ${t.label}`, hint: t.hint, run: () => saveLayout({ theme: t.id }) })),
    ...(["compact", "comfortable", "spacious"] as const)
      .filter((d) => d !== (layout.density ?? "comfortable"))
      .map((d) => ({ id: "density-" + d, label: `Density: ${d}`, run: () => saveLayout({ density: d }) })),
    { id: "hover", label: `Hover to focus panes: ${layout.hoverFocus ? "turn off" : "turn on"}`, hint: "for Handy / voice typing", run: () => saveLayout({ hoverFocus: !layout.hoverFocus }) },
    { id: "ping", label: `Finish chime: ${layout.ping === false ? "turn on" : "turn off"}`, run: () => saveLayout({ ping: layout.ping === false }) },
    { id: "zoomin", label: "Zoom in / out / reset", keys: "Ctrl+= / Ctrl+- / Ctrl+0", run: () => {} },
  ];

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
        onPalette={() => setPalette(true)}
        onBoard={() => setDialog((d) => (d === "board" ? "" : "board"))}
        vertical={vertical}
        columns={columns}
      />
      {sidebar && <Sidebar names={names} onAdd={() => setAdding(true)} onSearch={() => setPalette(true)} />}
      <main className="grid-wrap">
        {names.length === 0 ? (
          <div className="welcome">
            <div className="welcome-mark" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </div>
            <h1>Start a hive</h1>
            <p>Run Claude Code, Codex, Gemini and API models side by side. Link them so they review and test each other's work.</p>
            <div className="welcome-actions">
              <button className="primary" onClick={() => setDialog("recipes")}>
                <IconTeam /> Set up a team
              </button>
              <button onClick={() => setAdding(true)}>
                <IconPlus /> Add one agent
              </button>
              <button onClick={() => store.openVerdict({})}>
                <IconScale /> Verdict
              </button>
            </div>
            <p className="welcome-tip">
              <kbd>Ctrl</kbd>
              <kbd>K</kbd> jump to any agent or command
            </p>
          </div>
        ) : (
          <Grid names={visible} columns={maximized ? 1 : columns} widths={maximized || vertical ? undefined : layout.widths} minRow={vertical ? 360 : 220}>
            {visible.map((n) => (
              <Pane
                key={n}
                name={n}
                index={names.indexOf(n)}
                onMaximize={() => toggleMaximize(n)}
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
        {dialog === "board" && <KanbanView onClose={() => setDialog("")} />}
        <CodeHost />
      </main>
      {adding && <AddAgentDialog onClose={() => setAdding(false)} />}
      {jobFor && <JobDialog agent={jobFor} onClose={() => setJobFor(null)} />}
      {drawer && <Drawer key={drawer} initialTab={drawer === "usage" ? "usage" : undefined} onClose={() => setDrawer(false)} />}
      {dialog === "recipes" && <RecipesDialog onClose={() => setDialog("")} />}
      {dialog === "stats" && <StatsDialog onClose={() => setDialog("")} />}
      {linkReq && (
        <LinkDialog
          members={linkReq}
          onClose={() => {
            store.linkRequest = null;
            store.changed();
          }}
        />
      )}
      <VerdictWindow />
      {palette && <Palette actions={actions} onClose={() => setPalette(false)} />}
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
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.level}`} role={t.level === "error" ? "alert" : undefined}>
            {t.text}
          </div>
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

function TopBar({ names, selected, setSelected, onAdd, onHive, onUsage, onPalette, onBoard, vertical, columns }: {
  onUsage: () => void;
  vertical: boolean;
  columns: number;
  names: string[];
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  onAdd: () => void;
  onHive: () => void;
  onPalette: () => void;
  onBoard: () => void;
}) {
  const unread = useStore((s) => s.ownerUnread);
  const held = useStore((s) => s.heldTotal);
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
  return (
    <div className="topbar">
      <button className="ghost" onClick={toggleSidebar} title="toggle sidebar (Ctrl+\)" aria-label="toggle sidebar"><IconMenu /></button>
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
        onClick={() => {
          saveLayout({ ping: layout.ping === false });
          if (layout.ping === false) ping();
        }}
        title={layout.ping === false ? "sound off — click to chime when an agent finishes" : "chime when an agent finishes (click to mute)"}
        aria-label={layout.ping === false ? "finish sound off" : "finish sound on"}
      >
        {layout.ping === false ? <IconBellOff /> : <IconBell />}
      </button>
      <span className="cols" title="panes per row">
        <button className="ghost" disabled={cols <= 1} onClick={() => setCols(cols - 1)} aria-label="fewer columns">−</button>
        {cols} {cols === 1 ? "col" : "cols"}
        <button className="ghost" disabled={cols >= 8} onClick={() => setCols(cols + 1)} aria-label="more columns">+</button>
      </span>
      <UsageChip onClick={onUsage} />
      <button className="ghost" onClick={() => store.openVerdict({})} title="send one prompt to several agents; a judge picks the best parts">
        <IconScale /> <span className="bl">Verdict</span>
      </button>
      <button className="ghost cmd-btn" onClick={onPalette} title="jump to an agent or run any command (Ctrl+K)">
        <IconSearch /> <span className="bl">Commands</span> <kbd>Ctrl K</kbd>
      </button>
      <button className="ghost" onClick={onBoard} title="Kanban board (Ctrl+J)">
        <IconColumns /> <span className="bl">Board</span>
      </button>
      <button className={`hive-btn${unread || held ? " has-mail" : ""}`} onClick={onHive} title={`report, inbox, blackboard, mail (Ctrl+I)${held ? ` · ${held} message${held === 1 ? "" : "s"} waiting for your review` : ""}`}>
        <IconInbox /> <span className="bl">Hive</span>
        {unread + held ? <span className="count">{unread + held}</span> : null}
      </button>
      <button className="primary" onClick={onAdd} title="add agent (Ctrl+N)">
        <IconPlus /> Agent
      </button>
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
      {held && <PauseIcon title="automatic work held" />} 
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

function Sidebar({ names, onAdd, onSearch }: { names: string[]; onAdd: () => void; onSearch: () => void }) {
  const agents = useStore((s) => s.agents);
  const starting = useStore((s) => s.starting);
  const jobs = useStore((s) => s.jobs);
  const layout = useStore((s) => s.layout);
  const current = useSyncExternalStore(focus.subscribe, () => focus.active);
  const active = jobs.filter((j) => j.state === "active" || j.state === "queued");
  const [runsFor, setRunsFor] = useState<JobView | null>(null);
  const ended = jobs.filter((j) => !(j.state === "active" || j.state === "queued")).slice(-5).reverse();
  return (
    <aside className="sidebar">
      <button className="side-search" onClick={onSearch} title="jump to an agent or run a command">
        <IconSearch size={14} />
        <span>Search</span>
        <span className="spacer" />
        <kbd>Ctrl K</kbd>
      </button>
      <div className="side-head">
        <span>Agents</span>
        <button className="ghost" onClick={onAdd} title="add agent (Ctrl+N)" aria-label="add agent">
          <IconPlus size={14} />
        </button>
      </div>
      <ul className="agent-list">
        {names.map((n, i) => {
          const a = agents.get(n);
          const st = starting.get(n);
          const state = agentState(n);
          const model = a?.config.find((c) => c.category === "model" || c.id === "model");
          const go = () => {
            if (layout.maximized && layout.maximized !== n) saveLayout({ maximized: null });
            setTimeout(() => focus.to(n), 0);
          };
          return (
            <li
              key={n}
              className={`agent-item state-${state}${layout.maximized === n ? " max" : ""}${current === n ? " current" : ""}`}
              role="button"
              tabIndex={0}
              aria-current={current === n ? "true" : undefined}
              onClick={go}
              onKeyDown={onActivate(go)}
            >
              <div className="row1">
                <span className="idx">{i < 9 ? i + 1 : ""}</span>
                <strong>{n}</strong>
                <span className="spacer" />
                {a && a.unread > 0 && (
                  <span className="mono-meta" title="unread hive mail">
                    <IconInbox size={11} /> {a.unread}
                  </span>
                )}
                <span className={`state-word st-${state}`}>{STATE_LABEL[state]}</span>
              </div>
              <div className="row2 mono-meta" title={[a?.kind ?? st?.kind, model && labelOf(model), a?.branch].filter(Boolean).join(" · ")}>
                {/* one line; the model (longest, also in the pane header) is cut first */}
                <span>{a?.kind ?? st?.kind}</span>
                {a?.branch?.startsWith("hive/") && <span className="branch"> · {a.branch}</span>}
                {a?.ctx && <span> · {ctxPct(a.ctx.used, a.ctx.size)}%</span>}
                {model && <span> · {labelOf(model)}</span>}
              </div>
              {a?.note && state !== "idle" && <div className="row3" title={a.note}>{noteLabel(a.note)}</div>}
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
          <li key={j.id} title={j.prompt} className="clickable" role="button" tabIndex={0} onClick={() => setRunsFor(j)} onKeyDown={onActivate(() => setRunsFor(j))}>
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
          <li key={j.id} className="ended clickable" title={j.prompt} role="button" tabIndex={0} onClick={() => setRunsFor(j)} onKeyDown={onActivate(() => setRunsFor(j))}>
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
              {o.unread > 0 && <span className="badge" title="unread hive mail"><IconInbox size={11} /> {o.unread}</span>}
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
  const ref = useRef<HTMLDivElement>(null);
  const isTop = useOverlay("modal", onClose);
  // Keep keyboard focus inside the dialog, and give it back to where it was on close.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) (el.querySelector<HTMLElement>("[autofocus], input, select, textarea, button") ?? el).focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !el || !isTop()) return;
      const items = [...el.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !(x as HTMLButtonElement).disabled && x.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || !el.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !el.contains(document.activeElement))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", trap, true);
    return () => {
      window.removeEventListener("keydown", trap, true);
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} tabIndex={-1} className={`modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
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
        {policy === "allow-all" && !worktree && (
          <div className="hint small warn" role="note">
            Allow all outside a worktree: this agent runs commands as you and can change any file you can, including your checkout and hive's own settings. Prefer
            a worktree, or "ask".
          </div>
        )}
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
