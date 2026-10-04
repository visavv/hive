/** The pane UI shell: boot and sync with the backend, global keys, top bar, sidebar, the grid of panes and the dialogs. */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { JobView, Layout, Policy, WorktreeView } from "../protocol.js";
import { connect, hello, onEvent, onFocusLast, rpc } from "./bridge.js";
import { ping, store, useStore } from "./store.js";
import { watchUsage, type UsageSummary } from "./usage.js";
import { Pane } from "./Pane.js";
import { Drawer } from "./Drawer.js";
import { GroupChat, GroupsSection, LinkDialog, PauseIcon } from "./Links.js";
import { VerdictWindow } from "./Verdict.js";
import { StatsDialog } from "./Stats.js";
import { KanbanView } from "./Kanban.js";
import { CodeHost, codeActions, openCode } from "./Code.js";
import { DeviceDock, openDevice } from "./Devices.js";
import { installVoice, MicButton, useVoiceTarget, voiceActions, VoiceLayer } from "./Voice.js";
import { MobileNav, useMobile, useMobileAgent } from "./Mobile.js";

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
import { maxedName, openPane, saveLayout, toggleMaximize } from "./layout.js";
import { Modal } from "./Modal.js";
import { Grid } from "./Grid.js";
import { AddAgentDialog, JobDialog } from "./AgentDialogs.js";
import { agentState, rollup, STATE_LABEL, StatePill, stateOfStatus, type AgentState } from "./state.js";
import { IconBell, IconBellOff, IconColumns, IconInbox, IconLink, IconMenu, IconPlus, IconScale, IconSearch, IconTeam } from "./Icons.js";
import { RecipesDialog, SkillsDialog } from "./Extras.js";
import { focus, onActivate, overlays } from "./focus.js";
import { ctxPct, noteLabel } from "./format.js";


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
  installVoice();
}

export function App() {
  useEffect(boot, []);
  const ready = useStore((s) => s.ready);
  const layout = useStore((s) => s.layout);
  const toasts = useStore((s) => s.toasts);
  const [adding, setAdding] = useState(false);
  const [jobFor, setJobFor] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<false | "default" | "usage" | "learn">(false);
  const [dialog, setDialog] = useState<"" | "recipes" | "skills" | "stats" | "board" | "keys">("");
  const [palette, setPalette] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const skillReq = useStore((s) => s.skillRequest);
  const linkReq = useStore((s) => s.linkRequest);
  const groupOpen = useStore((s) => s.groupOpen);

  const names = layout.panes.map((p) => p.name);
  const maximized = maxedName(layout);
  // phones: one agent at a time, picked in the bottom bar (Mobile.tsx)
  const mobile = useMobile();
  const mobileAgent = useMobileAgent(names);
  const visible = mobile ? (mobileAgent ? [mobileAgent] : []) : maximized ? [maximized] : names;
  useEffect(() => focus.setOrder(names), [names.join("|")]);

  // Title shows the most urgent state across panes (same rule as the pills), so it's visible from the taskbar.
  const states = useStore(() => names.map((n) => agentState(n)).join(","));
  useEffect(() => {
    const all = states ? (states.split(",") as AgentState[]) : [];
    const top = rollup(all);
    const n = all.filter((s) => s === top).length;
    document.title = top === "needs" ? `(${n}) hive — needs you` : top === "error" ? `(${n}) hive — error` : top === "done" ? `✓${n} hive — ready` : "hive";
  }, [states]);

  // 9:16 monitors: tall or narrow windows get one column and no sidebar (unless you choose otherwise).
  const portrait = useMedia("(max-aspect-ratio: 4/5), (max-width: 820px)");
  const orientation = layout.orientation ?? "auto";
  const vertical = orientation === "vertical" || (orientation === "auto" && portrait);
  const sidebar = !mobile && (vertical ? !!layout.vsidebar : layout.sidebar);
  const columns = vertical ? (layout.vcolumns ?? 1) : layout.columns;

  const boardOpen = useRef(false);
  boardOpen.current = dialog === "board";
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      // Read the layout now, not from the render this handler was made in.
      const names = store.layout.panes.map((p) => p.name);
      const maximized = maxedName(store.layout);
      // A dialog, the drawer or the palette is open: pane shortcuts would act on
      // what's hidden behind it. Only zoom, the palette, and the key that closes the top overlay pass.
      const top = overlays.top;
      if (top) {
        const zoom = mod && (e.key === "=" || e.key === "+" || e.key === "-" || e.key === "0");
        const k = e.key.toLowerCase();
        // the palette may open over the drawer, the board and the code view, never over a form dialog
        const palette = mod && !e.shiftKey && k === "k" && (top === "palette" || top === "drawer" || top === "panel");
        const closesTop = mod && !e.shiftKey && ((top === "drawer" && k === "i") || (top === "panel" && k === "j" && boardOpen.current));
        if (!zoom && !palette && !closesTop) return;
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
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setDialog((d) => (d === "board" ? "" : "board"));
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === "i") {
        e.preventDefault();
        setDrawer((d) => (d ? false : "default"));
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        openCode({ find: true });
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === "m") {
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
    {
      id: "git-init",
      label: "Make this folder a git project (agents can then get their own branches)",
      run: () =>
        void rpc("gitInit", {})
          .then((r) => store.toast(r.result === "already" ? `${r.cwd} is already a git project` : `${r.cwd} is now a git project — restart an agent (or add one with a worktree) to give it its own branch`))
          .catch((e) => store.toast(e.message, "error")),
    },
    { id: "learn", label: "Memory and learning: what hive knows about you, skills it suggests", run: () => setDrawer("learn") },
    { id: "stats", label: "Token stats: by provider, model, task, project", hint: "all projects, kept for good", run: () => setDialog("stats") },
    { id: "keys", label: "Keyboard shortcuts", hint: "every key hive listens to", run: () => setDialog("keys") },
    { id: "broadcast", label: "Message all agents", keys: "Ctrl+Shift+B", run: () => setTimeout(() => document.querySelector<HTMLInputElement>(".broadcast input")?.focus(), 0) },
    { id: "sidebar", label: "Toggle sidebar", keys: "Ctrl+B", run: () => toggleSidebar() },
    { id: "max", label: "Maximize / restore the focused agent", keys: "Ctrl+M", run: () => toggleMaximize(focus.active) },
    { id: "layout", label: `Layout: ${layout.orientation === "vertical" ? "horizontal" : layout.orientation === "horizontal" ? "auto" : "vertical"} (now ${layout.orientation ?? "auto"})`, run: () => saveLayout({ orientation: layout.orientation === "vertical" ? "horizontal" : layout.orientation === "horizontal" ? "auto" : "vertical" }) },
    { id: "board", label: "Board (Kanban): Draft, In progress, Done", keys: "Ctrl+J", run: () => setDialog((d) => (d === "board" ? "" : "board")) },
    ...codeActions(),
    { id: "browser", label: "Open browser…", hint: "sandboxed: its own profile, never your logins", run: () => openDevice("browser") },
    { id: "android", label: "Android device…", hint: "emulator or phone over adb", run: () => openDevice("android") },
    ...THEMES.filter((t) => t.id !== (layout.theme ?? "dark")).map((t) => ({ id: "theme-" + t.id, label: `Theme: ${t.label}`, hint: t.hint, run: () => saveLayout({ theme: t.id }) })),
    ...(["compact", "comfortable", "spacious"] as const)
      .filter((d) => d !== (layout.density ?? "comfortable"))
      .map((d) => ({ id: "density-" + d, label: `Density: ${d}`, run: () => saveLayout({ density: d }) })),
    { id: "hover", label: `Hover to focus panes: ${layout.hoverFocus ? "turn off" : "turn on"}`, hint: "for Handy / voice typing", run: () => saveLayout({ hoverFocus: !layout.hoverFocus }) },
    { id: "ping", label: `Finish chime: ${layout.ping === false ? "turn on" : "turn off"}`, run: () => togglePing() },
    { id: "zoomin", label: "Zoom in", hint: "Ctrl+- zooms out, Ctrl+0 resets", keys: "Ctrl+=", run: () => saveLayout({ zoom: Math.min(2, Math.round(((layout.zoom ?? 1) + 0.1) * 10) / 10) }) },
    ...voiceActions(names),
  ];

  // the Hive panel docks beside the panes by default (they make room); it floats on phones and in the vertical layout
  const docked = !mobile && !vertical && layout.dockDrawer !== false;
  if (!ready) return <div className="boot">starting hive…</div>;

  return (
    <div className={`app${sidebar ? "" : " nosidebar"}${vertical ? " vertical" : ""}${mobile ? " mobile" : ""}${drawer && docked ? " drawer-docked" : ""}`}>
      {!mobile && <TopBar
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
      />}
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
          <Grid names={visible} columns={maximized ? 1 : columns} widths={maximized ? undefined : vertical ? layout.vwidths : layout.widths} widthsKey={vertical ? "vwidths" : "widths"} heights={maximized ? undefined : vertical ? layout.vheights : layout.heights} heightsKey={vertical ? "vheights" : "heights"} minRow={vertical ? 360 : 220}>
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
      {mobile && (
        <MobileNav
          names={names}
          actions={actions}
          board={dialog === "board"}
          onBoard={() => setDialog((d) => (d === "board" ? "" : "board"))}
          onInbox={() => setDrawer("default")}
          onPalette={() => setPalette(true)}
        />
      )}
      {adding && <AddAgentDialog onClose={() => setAdding(false)} />}
      {jobFor && <JobDialog agent={jobFor} onClose={() => setJobFor(null)} />}
      {drawer && (
        <Drawer
          key={drawer}
          initialTab={drawer === "usage" ? "usage" : drawer === "learn" ? "learn" : undefined}
          onClose={() => setDrawer(false)}
          docked={docked}
          onDock={mobile ? undefined : (d) => saveLayout({ dockDrawer: d })}
        />
      )}
      {dialog === "recipes" && <RecipesDialog onClose={() => setDialog("")} />}
      {dialog === "stats" && <StatsDialog onClose={() => setDialog("")} />}
      {dialog === "keys" && <KeysDialog onClose={() => setDialog("")} />}
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
      <VoiceLayer />
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
      <DeviceDock />
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
/** Every shortcut in one place, for people who don't read tooltips. */
const KEYS: [string, string][] = [
  ["Ctrl+K", "jump to an agent or run any command"],
  ["Ctrl+1 … 9", "focus pane 1 … 9"],
  ["Ctrl+Tab / Ctrl+Shift+Tab", "next / previous pane"],
  ["Ctrl+M", "maximize or restore the focused pane"],
  ["Ctrl+N", "add an agent"],
  ["Ctrl+Shift+B", "message all agents (the broadcast box)"],
  ["Ctrl+I", "open or close the Hive panel"],
  ["Ctrl+J", "open or close the board"],
  ["Ctrl+P", "open a file in the code view"],
  ["Ctrl+Shift+K", "run a skill"],
  ["Ctrl+B", "show or hide the sidebar"],
  ["Ctrl+= / Ctrl+- / Ctrl+0", "zoom in / out / reset"],
  ["Enter", "send (Shift+Enter for a new line); while the agent works it queues"],
  ["Esc", "cancel the agent's turn, close a menu or dialog"],
  ["↑ in an empty box", "recall your last prompt"],
  ["/", "list the agent's commands"],
  ["Ctrl+Shift+Enter", "✦ improve the prompt you're typing"],
  ["Ctrl+E", "open the big editor for long prompts"],
  ["Ctrl+Shift+Space (hold)", "dictate"],
  ["Ctrl+Alt+H", "bring hive to the front from any app"],
];
function KeysDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <table className="keys-table">
        <tbody>
          {KEYS.map(([k, what]) => (
            <tr key={k}>
              <td>
                {k.split(" / ").map((part, i) => (
                  <span key={i}>
                    {i > 0 && " / "}
                    <kbd>{part}</kbd>
                  </span>
                ))}
              </td>
              <td>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

/** Chime on finished turns: one toggle for the bell and the palette (plays a sample when turning on). */
function togglePing() {
  const off = store.layout.ping === false;
  saveLayout({ ping: off });
  if (off) ping();
}

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
  const learn = useStore((s) => s.learnPending);
  const layout = useStore((s) => s.layout);
  const [text, setText] = useState("");
  const targets = names.filter((n) => selected.has(n) && store.agents.has(n));
  const bcRef = useRef<HTMLInputElement>(null);
  const send = (raw = text) => {
    const t = raw.trim();
    if (!t) return;
    const to = targets.length ? targets : names.filter((n) => store.agents.has(n));
    if (!to.length) return store.toast("no running agents to broadcast to", "error");
    const mode = layout.broadcastMode ?? "team";
    rpc("broadcast", { names: to, text: t, mode })
      .then(({ lead }) => store.toast(lead ? `team task: ${lead} leads and hands out parts to ${to.filter((n) => n !== lead).join(", ")}` : `sent to ${to.join(", ")}`))
      .catch((e) => store.toast(e.message, "error"));
    setText("");
  };
  useVoiceTarget("@broadcast", { el: () => bcRef.current, setText, send });
  const cols = columns;
  const setCols = (n: number) => saveLayout(vertical ? { vcolumns: n, vwidths: undefined } : { columns: n, widths: undefined });
  const readyNames = useStore((s) => names.filter((n) => s.readyAt.has(n)));
  return (
    <div className="topbar">
      <button className="ghost" onClick={toggleSidebar} title="toggle sidebar (Ctrl+B)" aria-label="toggle sidebar"><IconMenu /></button>
      <span className="brand">hive</span>
      <div className="broadcast">
        <input
          ref={bcRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder={
            targets.length ? `broadcast to ${targets.join(", ")}…` : `broadcast to all ${names.length} agents… (tick pane boxes to pick)`
          }
        />
        <MicButton target="@broadcast" />
        <select
          className="bc-mode"
          value={layout.broadcastMode ?? "team"}
          onChange={(e) => saveLayout({ broadcastMode: e.target.value as "team" | "each" })}
          aria-label="how to broadcast"
          title="Team: one agent leads, plans and hands each the part that fits their role; the rest wait for it. Each: the same message to every agent."
        >
          <option value="team">as a team</option>
          <option value="each">to each</option>
        </select>
        <button onClick={() => send()} disabled={!text.trim()}>Send</button>
        {targets.length >= 2 && (
          <button className="ghost group-sel" onClick={() => store.requestLink(targets)} title={`link ${targets.join(", ")} into a group so they can talk and review each other`}>
            <IconLink size={14} /> Group {targets.length}
          </button>
        )}
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
        onClick={togglePing}
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
      <button className="ghost cmd-btn" onClick={onPalette} title="jump to an agent or run any command (Ctrl+K)">
        <IconSearch /> <span className="bl">Commands</span> <kbd>Ctrl K</kbd>
      </button>
      <button className="ghost" onClick={onBoard} title="Kanban board (Ctrl+J)">
        <IconColumns /> <span className="bl">Board</span>
      </button>
      <button className={`hive-btn${unread || held || learn ? " has-mail" : ""}`} onClick={onHive} title={`report, inbox, blackboard, mail, learning (Ctrl+I)${held ? ` · ${held} message${held === 1 ? "" : "s"} waiting for your review` : ""}${learn ? ` · ${learn} thing${learn === 1 ? "" : "s"} hive learned, waiting for your OK` : ""}`}>
        <IconInbox /> <span className="bl">Hive</span>
        {unread + held + learn ? <span className="count">{unread + held + learn}</span> : null}
      </button>
      <button className="primary" onClick={onAdd} title="add agent (Ctrl+N)">
        <IconPlus /> Agent
      </button>
    </div>
  );
}

/** Fullest subscription window across providers; amber/red as it fills, ⏸ when automatic work is held. */
function UsageChip({ onClick }: { onClick: () => void }) {
  const [u, setU] = useState<UsageSummary | null>(null);
  useEffect(() => watchUsage(setU), []);
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
                {/* the vendor's default model says nothing; a chosen one is worth the space */}
                {model && !/^default\b/i.test(labelOf(model)) && <span> · {labelOf(model)}</span>}
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
            <div className="row2 dim">{j.schedule}</div>
            <div className="row3 dim">{j.runs} run{j.runs === 1 ? "" : "s"} so far</div>
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
  // finished skill runs and sleeping agents pile up over weeks: keep the live ones visible, fold the rest
  const live = others.filter((o) => o.status !== "asleep" || o.unread > 0);
  const asleep = others.filter((o) => !live.includes(o));
  const [showAsleep, setShowAsleep] = useState(false);
  if (!others.length) return null;
  const shown = showAsleep ? others : live;
  return (
    <>
      <div className="side-head">
        <span>Other agents in this hive</span>
        {asleep.length > 0 && (
          <button className="ghost small" onClick={() => setShowAsleep(!showAsleep)} title={showAsleep ? "hide finished agents" : "show finished agents (they resume when opened)"}>
            {showAsleep ? "hide finished" : `${asleep.length} finished`}
          </button>
        )}
      </div>
      <ul className="job-list">
        {shown.map((o) => (
          <li key={o.name} title={`${o.cwd}${o.where ? ` — running in ${o.where}` : ""}`}>
            <div className="row1">
              <StatePill state={stateOfStatus(o.status)} compact />
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

