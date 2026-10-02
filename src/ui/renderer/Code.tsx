/**
 * Code view (Ctrl+P): read the code agents are writing, with syntax
 * highlighting, git status marks and the agent's changes — and ask the
 * teacher agent about any lines you select.
 *
 * - Folder: the focused agent's folder (its worktree if it has one), the
 *   project, or any other agent's folder.
 * - Files: a lazy tree of what git tracks plus new files (.gitignore respected).
 * - Changes: the agent branch against its base (or uncommitted changes).
 * - Select lines (drag, or click / Shift+click the line numbers) and a toolbar
 *   offers Explain, Why like this?, Simpler?, Quiz me and Ask…; the question
 *   goes to the teacher with the path, line range and the code.
 * - Explain every change: per agent, the teacher explains each turn that
 *   changed files (automatic work; the backend rate-limits and budgets it).
 *
 * Read-only: nothing here writes files.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CodeTarget } from "../protocol.js";
import { rpc } from "./bridge.js";
import { store, useStore } from "./store.js";
import { focus, useOverlay } from "./focus.js";
import { Modal } from "./Modal.js";
import { openPane, saveLayout } from "./layout.js";
import { Transcript } from "./Pane.js";
import type { PaletteAction } from "./Palette.js";
import { IconClose, IconSearch, IconSend } from "./Icons.js";
import { fenceOf, highlightLine, highlightLines, langOf } from "./highlight.js";

type FileList = Awaited<ReturnType<typeof rpc<"listFiles">>>;
type FileContent = Awaited<ReturnType<typeof rpc<"readFile">>>;
type CodeDiff = Awaited<ReturnType<typeof rpc<"fileDiff">>>;

export interface CodeRequest {
  /** Agent whose folder to show ("" = the project). Default: the focused agent. */
  agent?: string;
  path?: string;
  line?: number;
  tab?: "files" | "changes";
  /** Focus the "find file" box. */
  find?: boolean;
}

// ---- module state (a tiny store, so App.tsx only needs to mount <CodeHost/>) ----

const subs = new Set<() => void>();
const state = {
  version: 0,
  req: null as (CodeRequest & { nonce: number }) | null,
  /** Agents with "explain every change" on, and the running teacher. */
  explain: new Set<string>(),
  teacher: undefined as string | undefined,
  /** A question waiting for a teacher to be started (dialog open). */
  pendingAsk: null as { text: string } | null,
};
function changed() {
  state.version++;
  for (const s of subs) s();
}
function useCodeState() {
  useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => void subs.delete(f);
    },
    () => state.version,
  );
  return state;
}
let nonce = 0;

/** Open the code view (palette, Ctrl+P, a file path in a tool card). */
export function openCode(req: CodeRequest = {}) {
  state.req = { ...req, nonce: ++nonce };
  changed();
}
export function closeCode() {
  state.req = null;
  changed();
}

export function refreshExplain() {
  void rpc("explainChanges", {})
    .then((r) => {
      state.explain = new Set(r.agents);
      state.teacher = r.teacher;
      changed();
    })
    .catch(() => {});
}

export function setExplain(agent: string, on: boolean) {
  void rpc("explainChanges", { agent, on })
    .then((r) => {
      state.explain = new Set(r.agents);
      state.teacher = r.teacher;
      changed();
      store.toast(
        on
          ? `Explain every change: the teacher explains each turn of ${agent} that changes files (automatic work, at most every 2 minutes)${r.teacher ? "" : " — start a teacher first"}`
          : `Explain every change is off for ${agent}`,
      );
    })
    .catch((e) => store.toast(e.message, "error"));
}

/** The teacher pane: an agent from the teacher preset (or with the role "teacher"). */
export function findTeacher(): string | undefined {
  const panes = store.layout.panes;
  const byPreset = panes.find((p) => p.preset === "teacher" && store.agents.has(p.name))?.name;
  if (byPreset) return byPreset;
  for (const a of store.agents.values()) if (a.role === "teacher") return a.name;
  return state.teacher && store.agents.has(state.teacher) ? state.teacher : undefined;
}

/** Send a question to the teacher, or offer to start one first. */
export function askTeacher(text: string) {
  const t = findTeacher();
  if (!t) {
    state.pendingAsk = { text };
    changed();
    return;
  }
  sendToTeacher(t, text);
}

function sendToTeacher(name: string, text: string) {
  void rpc("prompt", { name, text }).catch((e) => store.toast(e.message, "error"));
  store.clearReady(name);
  // The code view docks the teacher's transcript; without it open, jump to the pane.
  if (!state.req) {
    if (store.layout.maximized && store.layout.maximized !== name) saveLayout({ maximized: null });
    setTimeout(() => focus.to(name), 0);
  }
}

/** Ask to start a teacher (palette "Start a teacher"). */
export function requestTeacher() {
  const t = findTeacher();
  if (t) {
    store.toast(`${t} is your teacher — select code in the code view (Ctrl+P) and ask`);
    if (!state.req) setTimeout(() => focus.to(t), 0);
    return;
  }
  state.pendingAsk = { text: "" };
  changed();
}

async function startTeacher(kind: string, cwd: string, text: string) {
  const taken = new Set([...store.layout.panes.map((p) => p.name), ...store.others.map((o) => o.name)]);
  let name = "teacher";
  for (let i = 2; taken.has(name); i++) name = `teacher${i}`;
  await openPane({ name, kind, cwd, role: "teacher", policy: "allow-reads", preset: "teacher", worktree: false });
  const err = store.starting.get(name)?.error;
  if (err) return store.toast(`teacher couldn't start: ${err}`, "error");
  state.teacher = name;
  changed();
  if (text) sendToTeacher(name, text);
  else if (!state.req) setTimeout(() => focus.to(name), 300);
}

/** Palette entries for the code view and the teacher. */
export function codeActions(): PaletteAction[] {
  const cur = focus.active && store.agents.has(focus.active) ? focus.active : undefined;
  const acts: PaletteAction[] = [
    { id: "code-open", label: "Open file…", hint: "find a file by name", keys: "Ctrl+P", run: () => openCode({ find: true }) },
    { id: "code-browse", label: "Browse code", hint: cur ? `${cur}'s folder` : "the project", run: () => openCode({}) },
    { id: "code-changes", label: `Code changes${cur ? ` of ${cur}` : ""}`, hint: "what changed, highlighted", run: () => openCode({ tab: "changes" }) },
    { id: "teacher-start", label: "Start a teacher", hint: "an agent that explains the code to you", run: requestTeacher },
  ];
  const teacher = findTeacher();
  if (cur && cur !== teacher) {
    const on = state.explain.has(cur);
    acts.push({ id: "explain-toggle", label: `Explain every change by ${cur}: turn ${on ? "off" : "on"}`, hint: "the teacher explains each change (uses tokens)", run: () => setExplain(cur, !on) });
  }
  return acts;
}

/** A file path in a tool card or diff (.code-link) opens it in the code view. */
let linksBound = false;
function bindLinks() {
  if (linksBound) return;
  linksBound = true;
  document.addEventListener(
    "click",
    (e) => {
      const el = (e.target as HTMLElement | null)?.closest?.<HTMLElement>(".code-link[data-path]");
      if (!el) return;
      e.preventDefault();
      e.stopPropagation(); // the tool card header would toggle open
      const agent = el.closest<HTMLElement>("[data-pane]")?.dataset.pane;
      const line = Number(el.dataset.line) || undefined;
      openCode({ agent: agent && store.agents.has(agent) ? agent : undefined, path: el.dataset.path!, line });
    },
    true,
  );
}

// ---- host: mounted once by App ----

export function CodeHost() {
  const st = useCodeState();
  useEffect(() => {
    bindLinks();
    refreshExplain();
  }, []);
  return (
    <>
      {st.req && <CodeView key={st.req.nonce} req={st.req} />}
      {st.pendingAsk && (
        <StartTeacherDialog
          text={st.pendingAsk.text}
          onClose={() => {
            state.pendingAsk = null;
            changed();
          }}
        />
      )}
    </>
  );
}

function StartTeacherDialog({ text, onClose }: { text: string; onClose: () => void }) {
  const kinds = useStore((s) => s.kinds);
  const [kind, setKind] = useState(kinds.find((k) => k.id === "claude")?.id ?? kinds[0]?.id ?? "");
  const dflt = (state.req?.agent && store.agents.get(state.req.agent)?.cwd) || store.cwd;
  const [cwd, setCwd] = useState(dflt);
  return (
    <Modal title={text ? "Start a teacher to answer this" : "Start a teacher"} onClose={onClose}>
      <form
        className="form teacher-form"
        onSubmit={(e) => {
          e.preventDefault();
          onClose();
          void startTeacher(kind, cwd.trim() || store.cwd, text);
        }}
      >
        <p className="dim small">
          A teacher is an agent that reads the code (it never changes it) and explains it to you: short paragraphs, every idea tied to the exact lines, jargon
          defined, a quiz when you ask. New terms go on your board as glossary cards.
        </p>
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
        <label>
          <span>Folder</span>
          <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder={store.cwd} />
        </label>
        <div className="buttons">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary">
            {text ? "Start and ask" : "Start"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---- the view ----

type Row = { n: number | null; html: string; raw: string; cls?: string };
type Sel = { from: number; to: number };

const QUESTIONS = {
  explain: { label: "Explain", q: "Help me understand what these lines do. Use the hint ladder: start by asking me what I think they do." },
  why: { label: "Why like this?", q: "Why is the code written like this? What does each part make possible, and what would be harder or break if it were written another way?" },
  simpler: { label: "Simpler?", q: "Could this be simpler or clearer? If so, show a simpler version in your answer and explain the trade-off. Don't change any files." },
  quiz: { label: "Quiz me", q: "Quiz me: ask me one check-your-understanding question about these lines. Don't give the answer until I reply." },
  hint: { label: "Next hint", q: "Next hint, please: go up one level on the hint ladder for what we're working on (these lines)." },
  answer: { label: "Show answer", q: "Show answer: I'd like the full answer now (hint level 6), then a short recap of what I could have noticed at each level." },
} as const;
type QKind = keyof typeof QUESTIONS | "ask";

function fence(code: string, lang: string) {
  let f = "```";
  while (code.includes(f)) f += "`";
  return `${f}${lang}\n${code}\n${f}`;
}

function CodeView({ req }: { req: CodeRequest & { nonce: number } }) {
  const agents = useStore((s) => s.agents);
  const st = useCodeState();
  const [target, setTarget] = useState<string>(() => {
    if (req.agent !== undefined) return req.agent;
    const a = focus.active;
    return a && store.agents.has(a) ? a : "";
  });
  const [tab, setTab] = useState<"files" | "changes">(req.tab ?? "files");
  const [list, setList] = useState<FileList | null>(null);
  const [listErr, setListErr] = useState("");
  const [find, setFind] = useState("");
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set([""]));
  const [file, setFile] = useState<FileContent | null>(null);
  const [fileErr, setFileErr] = useState("");
  const [jump, setJump] = useState<number | undefined>(req.line);
  const [diff, setDiff] = useState<CodeDiff | null>(null);
  const [diffErr, setDiffErr] = useState("");
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [sel, setSel] = useState<Sel | null>(null);
  const [asking, setAsking] = useState(false);
  const [dock, setDock] = useState(true);
  const findRef = useRef<HTMLInputElement>(null);
  const t: CodeTarget = target ? { agent: target } : {};
  const teacher = useStore(() => findTeacher());
  const selRef = useRef<{ sel: Sel | null; asking: boolean }>({ sel, asking });
  selRef.current = { sel, asking };

  // Esc clears a selection first (registered before the overlay's own Escape handler, so it runs first).
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !selRef.current.sel || document.querySelector(".modal")) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setSel(null);
      setAsking(false);
      window.getSelection()?.removeAllRanges();
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, []);
  useOverlay("modal", closeCode);

  useEffect(() => {
    if (req.find) setTimeout(() => findRef.current?.focus(), 0);
  }, []);

  // Folder changed: reload its file list (and its changes when that tab is showing).
  useEffect(() => {
    setList(null);
    setListErr("");
    rpc("listFiles", t)
      .then(setList)
      .catch((e) => setListErr(e.message));
  }, [target]);
  useEffect(() => {
    if (tab !== "changes") return;
    setDiff(null);
    setDiffErr("");
    rpc("fileDiff", t)
      .then((d) => {
        setDiff(d);
        setDiffPath((p) => (p && d.files.some((f) => f.path === p) ? p : (d.files[0]?.path ?? null)));
      })
      .catch((e) => setDiffErr(e.message));
  }, [target, tab]);

  const openFile = (path: string, line?: number) => {
    setTab("files");
    setSel(null);
    setAsking(false);
    setFileErr("");
    rpc("readFile", { ...t, path })
      .then((f) => {
        setFile(f);
        setJump(line);
        if (line) setSel({ from: line - 1, to: line - 1 });
        // Unfold the folders down to it.
        const parts = f.path.split("/");
        setOpenDirs((o) => {
          const n = new Set(o);
          for (let i = 1; i < parts.length; i++) n.add(parts.slice(0, i).join("/"));
          return n;
        });
      })
      .catch((e) => {
        setFile(null);
        setFileErr(e.message);
      });
  };
  useEffect(() => {
    if (req.path) openFile(req.path, req.line);
  }, []);

  const rows: Row[] = useMemo(() => {
    if (tab === "files") {
      if (!file) return [];
      const html = highlightLines(file.text, langOf(file.path));
      const raw = file.text.split("\n");
      if (raw.length > 1 && raw[raw.length - 1] === "") {
        raw.pop();
        html.pop();
      }
      return raw.map((l, i) => ({ n: i + 1, html: html[i] ?? "", raw: l }));
    }
    const f = diff?.files.find((x) => x.path === diffPath);
    if (!f) return [];
    const lang = langOf(f.path);
    const out: Row[] = [];
    let o = 0;
    let n = 0;
    for (const l of f.patch.split("\n")) {
      const h = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      if (h) {
        o = Number(h[1]);
        n = Number(h[2]);
        out.push({ n: null, html: escHtml(l), raw: l, cls: "hunk" });
      } else if (l.startsWith("+")) out.push({ n: n++, html: highlightLine(l.slice(1), lang), raw: l, cls: "add" });
      else if (l.startsWith("-")) out.push({ n: o++, html: highlightLine(l.slice(1), lang), raw: l, cls: "del" });
      else if (l.startsWith("\\")) out.push({ n: null, html: escHtml(l), raw: l, cls: "hunk" });
      else {
        out.push({ n: n++, html: highlightLine(l.slice(1), lang), raw: l, cls: "ctx" });
        o++;
      }
    }
    return out;
  }, [tab, file, diff, diffPath]);

  const where = target ? `${target}'s folder` : "the project";
  const root = tab === "files" ? (list?.root ?? "") : (diff?.root ?? list?.root ?? "");
  const curPath = tab === "files" ? file?.path : diffPath;

  const ask = (kind: QKind, freeText?: string) => {
    if (!sel || !curPath) return;
    const a = Math.min(sel.from, sel.to);
    const b = Math.max(sel.from, sel.to);
    const picked = rows.slice(a, b + 1);
    const nums = picked.map((r) => r.n).filter((x): x is number => x != null);
    const range = nums.length ? (nums[0] === nums[nums.length - 1] ? `line ${nums[0]}` : `lines ${nums[0]}–${nums[nums.length - 1]}`) : "";
    const code = picked.map((r) => r.raw).join("\n");
    const title = kind === "ask" ? "Question" : QUESTIONS[kind].label;
    const question = kind === "ask" ? freeText!.trim() : QUESTIONS[kind].q;
    const lang = tab === "changes" ? "diff" : fenceOf(curPath);
    const text = [
      `[learn] ${title} · ${curPath}${range ? ` ${range}` : ""}${tab === "changes" ? ` (changes${diff ? ` vs ${diff.base}` : ""})` : ""}`,
      `File: ${root ? `${root}/${curPath}` : curPath} (in ${where})`,
      "",
      fence(code, lang),
      "",
      question,
    ].join("\n");
    setAsking(false);
    askTeacher(text);
    if (findTeacher()) setDock(true);
  };

  const options = [
    { value: "", label: `Project · ${baseName(store.cwd)}` },
    ...[...agents.values()].map((a) => ({ value: a.name, label: `${a.name} · ${a.branch?.startsWith("hive/") ? a.branch : baseName(a.cwd)}` })),
  ];
  const explainOn = !!target && st.explain.has(target);

  return (
    <div className="code-view" role="dialog" aria-label="Code">
      <div className="code-bar">
        <strong>Code</strong>
        <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="whose folder" className="code-target">
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <div className="seg code-tabs">
          <button className={tab === "files" ? "on" : ""} onClick={() => setTab("files")}>
            Files
          </button>
          <button className={tab === "changes" ? "on" : ""} onClick={() => setTab("changes")}>
            Changes
          </button>
        </div>
        {list?.branch && <span className="branch small">{list.branch}</span>}
        <span className="spacer" />
        {target && target !== teacher && (
          <label className="code-explain" title="The teacher explains every turn of this agent that changes files. Automatic work: costs tokens, at most one explanation every 2 minutes, held by your spending guards.">
            <input type="checkbox" checked={explainOn} onChange={(e) => setExplain(target, e.target.checked)} />
            Explain every change
          </label>
        )}
        {teacher ? (
          <button className={`ghost${dock ? " on" : ""}`} onClick={() => setDock((d) => !d)} title="show or hide the teacher's answers">
            Teacher
          </button>
        ) : (
          <button className="ghost" onClick={requestTeacher} title="start an agent that explains the code to you">
            Start a teacher
          </button>
        )}
        <button className="ghost" onClick={closeCode} title="close (Esc)" aria-label="close code view">
          <IconClose />
        </button>
      </div>
      <div className={`code-body${teacher && dock ? " docked" : ""}`}>
        <aside className="code-side">
          {tab === "files" ? (
            <>
              <label className="code-find">
                <IconSearch size={13} />
                <input
                  ref={findRef}
                  value={find}
                  onChange={(e) => setFind(e.target.value)}
                  placeholder="Find file…"
                  aria-label="find file"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && list) {
                      const hit = matchFiles(list.files, find)[0];
                      if (hit) openFile(hit);
                    }
                  }}
                />
              </label>
              {listErr && <div className="err small pad">{listErr}</div>}
              {!list && !listErr && <div className="dim small pad">loading…</div>}
              {list && (find.trim() ? <FoundFiles list={list} q={find} cur={file?.path} onOpen={openFile} /> : <Tree list={list} open={openDirs} setOpen={setOpenDirs} cur={file?.path} onOpen={openFile} />)}
              {list?.truncated && <div className="dim small pad">showing the first {list.files.length.toLocaleString()} files</div>}
            </>
          ) : (
            <>
              {diffErr && <div className="err small pad">{diffErr}</div>}
              {!diff && !diffErr && <div className="dim small pad">loading…</div>}
              {diff && (
                <>
                  <div className="dim small pad">
                    {diff.files.length} file{diff.files.length === 1 ? "" : "s"} changed vs {diff.base}
                  </div>
                  <ul className="code-tree">
                    {diff.files.map((f) => (
                      <li key={f.path}>
                        <button className={`code-node file${diffPath === f.path ? " cur" : ""}`} onClick={() => (setDiffPath(f.path), setSel(null))} title={f.path}>
                          <span className={`code-mark m-${f.status[0].toUpperCase()}`}>{f.status === "added" ? "N" : f.status[0].toUpperCase()}</span>
                          <span className="code-name">{f.path}</span>
                          <span className="code-stat">
                            <span className="add">+{f.adds}</span> <span className="del">−{f.dels}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {!diff.files.length && <div className="dim small pad">No changes.</div>}
                  {diff.truncated && <div className="warn small pad">The diff is very large; it was cut.</div>}
                </>
              )}
            </>
          )}
        </aside>
        <section className="code-main">
          <div className="code-path">
            {curPath ? (
              <>
                <span className="mono-meta">{curPath}</span>
                {tab === "files" && file && list?.marks[file.path] && <span className={`code-mark m-${list.marks[file.path]}`}>{markLabel(list.marks[file.path])}</span>}
                <span className="spacer" />
                {tab === "files" && file && (
                  <span className="dim small">
                    {file.lines.toLocaleString()} lines · {langOf(file.path) ?? "text"}
                  </span>
                )}
                {tab === "changes" && diffPath && diff?.files.find((f) => f.path === diffPath)?.status !== "deleted" && (
                  <button className="ghost small" onClick={() => openFile(diffPath)}>
                    Open file
                  </button>
                )}
              </>
            ) : (
              <span className="dim">{tab === "files" ? "Pick a file on the left. Select lines to ask the teacher about them." : "Pick a changed file."}</span>
            )}
          </div>
          {fileErr && tab === "files" && <div className="code-msg err">{fileErr}</div>}
          <CodeLines
            key={`${tab}:${curPath}`}
            rows={rows}
            diff={tab === "changes"}
            sel={sel}
            setSel={(s) => {
              setSel(s);
              if (!s) setAsking(false);
            }}
            jump={tab === "files" ? jump : undefined}
            toolbar={
              sel && curPath ? (
                <AskToolbar
                  asking={asking}
                  setAsking={setAsking}
                  onAsk={ask}
                  teacher={teacher}
                />
              ) : null
            }
          />
        </section>
        {teacher && dock && <TeacherDock name={teacher} />}
      </div>
    </div>
  );
}

function AskToolbar({ asking, setAsking, onAsk, teacher }: { asking: boolean; setAsking: (v: boolean) => void; onAsk: (k: QKind, text?: string) => void; teacher?: string }) {
  const [text, setText] = useState("");
  return (
    <div className="code-ask" onMouseDown={(e) => e.stopPropagation()} onMouseUp={(e) => e.stopPropagation()} role="toolbar" aria-label="ask the teacher about the selected lines">
      {asking ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) onAsk("ask", text);
          }}
        >
          <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={`Ask ${teacher ?? "the teacher"} about these lines…`} aria-label="your question" />
          <button type="submit" className="primary small" disabled={!text.trim()}>
            Ask
          </button>
        </form>
      ) : (
        <>
          {(Object.keys(QUESTIONS) as (keyof typeof QUESTIONS)[]).map((k) => (
            <button key={k} className={k === "explain" ? "primary small" : "small"} onClick={() => onAsk(k)}>
              {QUESTIONS[k].label}
            </button>
          ))}
          <button className="small" onClick={() => setAsking(true)}>
            Ask…
          </button>
        </>
      )}
    </div>
  );
}

function CodeLines({ rows, diff, sel, setSel, jump, toolbar }: { rows: Row[]; diff: boolean; sel: Sel | null; setSel: (s: Sel | null) => void; jump?: number; toolbar: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [barTop, setBarTop] = useState(0);
  const anchor = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!jump || !ref.current) return;
    ref.current.querySelector(`[data-row="${jump - 1}"]`)?.scrollIntoView({ block: "center" });
  }, [jump, rows.length]);
  useLayoutEffect(() => {
    if (!sel || !ref.current) return;
    const last = ref.current.querySelector<HTMLElement>(`[data-row="${Math.max(sel.from, sel.to)}"]`);
    if (last) setBarTop(last.offsetTop + last.offsetHeight + 2);
  }, [sel?.from, sel?.to]);
  const rowOf = (n: Node | null): number | null => {
    const el = (n instanceof HTMLElement ? n : n?.parentElement)?.closest<HTMLElement>("[data-row]");
    return el && ref.current?.contains(el) ? Number(el.dataset.row) : null;
  };
  if (!rows.length) return <div className="code-lines empty" ref={ref} />;
  const lo = sel ? Math.min(sel.from, sel.to) : -1;
  const hi = sel ? Math.max(sel.from, sel.to) : -1;
  return (
    <div
      className={`code-lines${diff ? " diff" : ""}`}
      ref={ref}
      tabIndex={0}
      onMouseUp={() => {
        const s = window.getSelection();
        if (!s || s.isCollapsed) return;
        const a = rowOf(s.anchorNode);
        const b = rowOf(s.focusNode);
        if (a == null || b == null) return;
        // A drag that ends at the very start of a line doesn't include that line.
        setSel({ from: a, to: b > a && s.focusOffset === 0 ? b - 1 : b });
      }}
    >
      <div className="code-rows">
        {rows.map((r, i) => (
          <div key={i} data-row={i} className={`cl${r.cls ? " " + r.cls : ""}${i >= lo && i <= hi ? " sel" : ""}`}>
            <span
              className="ln"
              onMouseDown={(e) => {
                e.preventDefault();
                if (e.shiftKey && (anchor.current != null || sel)) setSel({ from: anchor.current ?? sel!.from, to: i });
                else {
                  anchor.current = i;
                  setSel(sel && sel.from === i && sel.to === i ? null : { from: i, to: i });
                }
                window.getSelection()?.removeAllRanges();
              }}
            >
              {r.n ?? ""}
            </span>
            {diff && <span className="sign">{r.cls === "add" ? "+" : r.cls === "del" ? "−" : r.cls === "hunk" ? "" : " "}</span>}
            <span className="lc hljs" dangerouslySetInnerHTML={{ __html: r.html || " " }} />
          </div>
        ))}
      </div>
      {toolbar && (
        <div className="code-ask-wrap" style={{ top: barTop }}>
          {toolbar}
        </div>
      )}
    </div>
  );
}

function TeacherDock({ name }: { name: string }) {
  const agent = useStore((s) => s.agents.get(name));
  const [text, setText] = useState("");
  const send = () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    void rpc("prompt", { name, text: t }).catch((e) => store.toast(e.message, "error"));
  };
  return (
    <aside className="code-dock" data-teacher={name}>
      <div className="code-dock-head">
        <strong>{name}</strong>
        <span className="dim small">{agent?.status === "working" ? "thinking…" : "teacher"}</span>
        <span className="spacer" />
        <button
          className="ghost small"
          onClick={() => {
            closeCode();
            if (store.layout.maximized && store.layout.maximized !== name) saveLayout({ maximized: null });
            setTimeout(() => focus.to(name), 0);
          }}
          title="close the code view and go to the teacher's pane"
        >
          Open pane
        </button>
      </div>
      <Transcript name={name} />
      <div className="code-dock-input">
        <textarea
          value={text}
          rows={Math.min(5, Math.max(1, text.split("\n").length))}
          placeholder={`Ask ${name} anything…`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="send" onClick={send} disabled={!text.trim()} title="send (Enter)" aria-label="send">
          <IconSend />
        </button>
      </div>
    </aside>
  );
}

// ---- file tree ----

type DirIndex = Map<string, { dirs: string[]; files: string[] }>;

function indexFiles(files: string[]): DirIndex {
  const idx: DirIndex = new Map([["", { dirs: [], files: [] }]]);
  for (const f of files) {
    const parts = f.split("/");
    let dir = "";
    for (let i = 0; i < parts.length - 1; i++) {
      const sub = dir ? `${dir}/${parts[i]}` : parts[i];
      if (!idx.has(sub)) {
        idx.set(sub, { dirs: [], files: [] });
        idx.get(dir)!.dirs.push(sub);
      }
      dir = sub;
    }
    idx.get(dir)!.files.push(f);
  }
  for (const v of idx.values()) v.dirs.sort((a, b) => a.localeCompare(b));
  return idx;
}

function Tree({ list, open, setOpen, cur, onOpen }: { list: FileList; open: Set<string>; setOpen: (s: Set<string>) => void; cur?: string; onOpen: (p: string) => void }) {
  const idx = useMemo(() => indexFiles(list.files), [list]);
  // Folders containing changed files get a dot.
  const changedDirs = useMemo(() => {
    const s = new Set<string>();
    for (const f of Object.keys(list.marks)) {
      const parts = f.split("/");
      for (let i = 1; i < parts.length; i++) s.add(parts.slice(0, i).join("/"));
    }
    return s;
  }, [list]);
  const toggle = (d: string) => {
    const n = new Set(open);
    if (n.has(d)) n.delete(d);
    else n.add(d);
    setOpen(n);
  };
  // Only open folders are rendered (lazy: a big repo's tree costs what you unfold).
  const render = (dir: string, depth: number): React.ReactNode => {
    const e = idx.get(dir);
    if (!e) return null;
    return (
      <>
        {e.dirs.map((d) => (
          <li key={d}>
            <button className="code-node dir" style={{ paddingLeft: 8 + depth * 12 }} onClick={() => toggle(d)} aria-expanded={open.has(d)}>
              <span className="chev">{open.has(d) ? "▾" : "▸"}</span>
              <span className="code-name">{d.slice(d.lastIndexOf("/") + 1)}</span>
              {changedDirs.has(d) && <span className="code-dot" title="contains changes" />}
            </button>
            {open.has(d) && <ul>{render(d, depth + 1)}</ul>}
          </li>
        ))}
        {e.files.map((f) => (
          <li key={f}>
            <button className={`code-node file${cur === f ? " cur" : ""}`} style={{ paddingLeft: 20 + depth * 12 }} onClick={() => onOpen(f)} title={f}>
              <span className="code-name">{f.slice(f.lastIndexOf("/") + 1)}</span>
              {list.marks[f] && <span className={`code-mark m-${list.marks[f]}`}>{markLabel(list.marks[f])}</span>}
            </button>
          </li>
        ))}
      </>
    );
  };
  if (!list.files.length) return <div className="dim small pad">No files.</div>;
  return <ul className="code-tree">{render("", 0)}</ul>;
}

function matchFiles(files: string[], q: string): string[] {
  const t = q.trim().toLowerCase();
  if (!t) return [];
  const scored: { f: string; s: number }[] = [];
  for (const f of files) {
    const lf = f.toLowerCase();
    const base = lf.slice(lf.lastIndexOf("/") + 1);
    const s = base === t ? 0 : base.startsWith(t) ? 1 : base.includes(t) ? 2 : lf.includes(t) ? 3 : -1;
    if (s >= 0) scored.push({ f, s });
  }
  return scored.sort((a, b) => a.s - b.s || a.f.length - b.f.length).map((x) => x.f).slice(0, 200);
}

function FoundFiles({ list, q, cur, onOpen }: { list: FileList; q: string; cur?: string; onOpen: (p: string) => void }) {
  const hits = useMemo(() => matchFiles(list.files, q), [list, q]);
  if (!hits.length) return <div className="dim small pad">No file matches “{q}”.</div>;
  return (
    <ul className="code-tree">
      {hits.map((f) => (
        <li key={f}>
          <button className={`code-node file found${cur === f ? " cur" : ""}`} onClick={() => onOpen(f)} title={f}>
            <span className="code-name">{f}</span>
            {list.marks[f] && <span className={`code-mark m-${list.marks[f]}`}>{markLabel(list.marks[f])}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

function markLabel(m: string): string {
  return m === "?" || m === "A" ? "N" : m;
}

function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
