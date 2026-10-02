/** One agent pane: header (name, role, state, actions), transcript, permission asks, and the composer (message box, "/" menu, ✦ improve). */
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentView, ElicitationAsk, PermissionAsk } from "../protocol.js";
import { rpc } from "./bridge.js";
import { renderMarkdown } from "./markdown.js";
import { store, usePane, useStore, type Item } from "./store.js";
import { focus, onActivate } from "./focus.js";
import { ctxPct, fmtIdle, statusLabel, noteLabel } from "./format.js";
import { PromptEditor } from "./Extras.js";
import { GroupChips, groupColor } from "./Links.js";
import { agentState, StatePill } from "./state.js";
import { IconClock, IconClose, IconExpand, IconLink, IconLock, IconSpark, IconMaximize, IconRefresh, IconSend, IconStop } from "./Icons.js";
import { MicButton, PaneVoiceControls, stopSpeech, useVoiceTarget } from "./Voice.js";

export function Pane({ name, index, onMaximize, onJob, selected, onSelect }: {
  name: string;
  index: number;
  onMaximize: () => void;
  onJob: () => void;
  selected: boolean;
  onSelect: (v: boolean) => void;
}) {
  const agent = useStore((s) => s.agents.get(name));
  const starting = useStore((s) => s.starting.get(name));
  const hoverFocus = useStore((s) => s.layout.hoverFocus);
  const waiting = useStore((s) => s.waitingOn(name));
  const ready = useStore((s) => s.readyAt.has(name));
  const state = useStore(() => agentState(name));
  const firstGroup = useStore((s) => s.groups.find((g) => g.members.includes(name))?.name);
  const linkColor = firstGroup ? groupColor(firstGroup) : undefined;
  // In the layout but not running (exited, closed by its job, backend restarted): stopped.
  const status = agent?.status ?? (starting ? (starting.error ? "error" : "starting") : "asleep");

  return (
    <section
      className={`pane status-${status}${waiting ? " needs-you" : ""}${ready && !waiting ? " ready" : ""}${linkColor ? " linked" : ""}`}
      data-pane={name}
      onMouseEnter={() => hoverFocus && focus.hoverStart(name)}
      onMouseLeave={() => focus.hoverEnd()}
      onMouseDown={(e) => {
        focus.setActive(name);
        store.clearReady(name);
        if (!(e.target as HTMLElement).closest(".voice-ctl")) stopSpeech(name); // a click stops its spoken reply
      }}
      onFocusCapture={() => store.clearReady(name)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("application/x-hive-agent")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "link";
          e.currentTarget.classList.add("drop-target");
        }
      }}
      onDragLeave={(e) => e.currentTarget.classList.remove("drop-target")}
      onDrop={(e) => {
        e.currentTarget.classList.remove("drop-target");
        const from = e.dataTransfer.getData("application/x-hive-agent");
        if (from && from !== name) {
          e.preventDefault();
          store.requestLink([from, name]);
        }
      }}
      style={linkColor ? ({ ["--grp" as any]: linkColor } as React.CSSProperties) : undefined}
    >
      <header className="pane-head" onDoubleClick={onMaximize} title="double-click to maximize">
        <input
          type="checkbox"
          className="sel"
          checked={selected}
          onChange={(e) => onSelect(e.target.checked)}
          title="include in broadcast"
          onDoubleClick={(e) => e.stopPropagation()}
        />
        <span className="idx">{index < 9 ? index + 1 : ""}</span>
        <strong
          className="pname"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData("application/x-hive-agent", name);
            e.dataTransfer.effectAllowed = "link";
          }}
          title="drag onto another pane to link them (so they can talk)"
        >
          {name}
        </strong>
        <span className="kind">{agent?.kind ?? starting?.kind}</span>
        {agent?.role && (
          <span className="role-badge" title={`role: ${agent.role}`}>
            {roleLabel(agent.role)}
          </span>
        )}
        <GroupChips agent={name} />
        <span className="spacer" />
        {agent?.ctx && <CtxMeter used={agent.ctx.used} size={agent.ctx.size} />}
        <StatePill state={state} />
        {agent && agent.queued > 0 && <span className="badge" title="prompts queued">{agent.queued} queued</span>}
        {agent && agent.jobs > 0 && <span className="badge job" title="scheduled jobs on this agent"><IconClock size={12} /> {agent.jobs}</span>}
        <div className="pane-actions" onDoubleClick={(e) => e.stopPropagation()}>
          <PaneVoiceControls name={name} />
          {agent && status === "working" && (
            <button onClick={() => void rpc("cancel", { name })} title="cancel turn (Esc)" aria-label="cancel turn"><IconStop /></button>
          )}
          {agent && (
            <button onClick={onJob} title="schedule a loop / interval / watch job" aria-label="schedule a job"><IconClock /></button>
          )}
          <button onClick={() => store.requestLink([name])} title="link with another agent (or drag this pane's name onto another pane)" aria-label="link with another agent">
            <IconLink />
          </button>
          {agent && (
            <button
              onClick={() => void rpc("newSession", { name }).catch((e) => store.toast(e.message, "error"))}
              title="fresh session (clears context)"
            >
              <IconRefresh />
            </button>
          )}
          <button onClick={onMaximize} title="maximize / restore" aria-label="maximize"><IconMaximize /></button>
          <button className="close" onClick={() => closePane(name)} title="close pane" aria-label="close pane"><IconClose /></button>
        </div>
      </header>
      {agent && (
        <div
          className="pane-sub"
          title={[agent.cwd, agent.branch && `branch ${agent.branch}`, agent.role, `permissions: ${agent.policy}`, agent.auth, agent.mcp?.length && `MCP: ${agent.mcp.join(", ")}`].filter(Boolean).join("\n")}
        >
          {agent.branch?.startsWith("hive/") ? (
            <span className="where branch">{agent.branch}</span>
          ) : (
            <span className="where">{agent.cwd.split(/[\\/]/).filter(Boolean).pop() ?? agent.cwd}</span>
          )}
          <span className={`pol pol-${agent.policy}`}>{POLICY_LABEL[agent.policy] ?? agent.policy}</span>
          {agent.auth?.startsWith("not logged in") && <span className="warn">not signed in</span>}
          <span className="spacer" />
          <span className="note">{noteLabel(agent.note)}</span>
          {status === "idle" && <span>idle {fmtIdle(agent.idleMs)}</span>}
        </div>
      )}
      <Transcript name={name} />
      {starting?.error ? (
        <div className="pane-error">
          Could not start: {starting.error}
          <button onClick={() => retry(name)}>Retry</button>
        </div>
      ) : !agent && !starting ? (
        <div className="pane-error stopped">
          Agent is not running.
          <button onClick={() => retry(name)}>Restart (resumes the session)</button>
        </div>
      ) : (
        <Composer name={name} agent={agent} />
      )}
    </section>
  );
}

/** One-line label for prompts hive generated, or undefined for what you typed. */
function autoPromptLabel(t: string): string | undefined {
  let m = t.match(/^You have (\d+) unread hive messages?: (.*?)\. Call hive_inbox/);
  if (m) return `Mail · ${m[2].replace(/ \(.*?\)/g, "").slice(0, 80)}`;
  m = t.match(/^\[hive job #(\d+), (\w+)(?:: ([^\]]+))?\]/);
  if (m) return `Job #${m[1]} · ${m[2]}${m[3] ? ` · ${m[3]}` : ""}`;
  if (t.startsWith("[team broadcast from the owner — you lead]")) return `Team task · you lead · ${(t.match(/\nTask: ([^\n]*)/)?.[1] ?? "").slice(0, 70)}`;
  m = t.match(/^\[follow-up from ([\w.-]+)\]/);
  if (m) return `Follow-up from ${m[1]}`;
  if (t.includes("You are agent \"") && t.includes("local multi-agent hive")) return "Briefing";
  return undefined;
}

const HIVE_QUIET: Record<string, string> = {
  hive_inbox: "checked mail",
  hive_status: "updated status",
  hive_agents: "looked up agents",
  hive_bb_get: "read the board",
  hive_bb_list: "read the board",
  hive_bb_set: "wrote to the board",
  hive_thread: "read a thread",
};
function hiveToolLine(title: string, status: string): string | undefined {
  const t = title.replace(/^mcp__hive__/, "").trim();
  const send = t.match(/^hive_send\s*(?:→\s*(\S+))?/);
  if (send) return `${status === "failed" ? "couldn't send" : "sent mail"}${send[1] ? ` to ${send[1]}` : ""}`;
  const k = Object.keys(HIVE_QUIET).find((x) => t === x || t.startsWith(x + " "));
  return k ? HIVE_QUIET[k] + (status === "failed" ? " (failed)" : "") : undefined;
}

/** A pane-header label for an agent's role: its first clause, short ("Code reviewer: checks…" → "Code reviewer"). */
export function roleLabel(role: string): string {
  const first = role.split(/[:.;,(—–\n]| - /)[0].trim() || role.trim();
  return first.length > 28 ? first.slice(0, 27).trimEnd() + "…" : first;
}

const POLICY_LABEL: Record<string, string> = { ask: "asks first", "allow-reads": "reads freely", "allow-all": "full access", "reject-all": "chat only" };

function closePane(name: string) {
  const jobs = store.agents.get(name)?.jobs ?? 0;
  if (jobs && !confirm(`${name} has ${jobs} scheduled job${jobs === 1 ? "" : "s"}. Close the pane and stop ${jobs === 1 ? "it" : "them"}?`)) return;
  const l = store.layout;
  store.layout = { ...l, panes: l.panes.filter((p) => p.name !== name), maximized: l.maximized === name ? null : l.maximized };
  store.starting.delete(name);
  store.panes.delete(name);
  store.readyAt.delete(name);
  focus.forget(name);
  store.changed();
  void rpc("saveLayout", store.layout);
  void rpc("removeAgent", { name, stopJobs: true }).catch(() => {});
}

function retry(name: string) {
  const spec = store.layout.panes.find((p) => p.name === name);
  if (!spec) return;
  store.starting.set(name, { kind: spec.kind });
  store.changed();
  rpc("addAgent", { ...spec, resume: true })
    .then(() => {
      store.starting.delete(name);
      store.changed();
    })
    .catch((e) => {
      store.starting.set(name, { kind: spec.kind, error: e.message });
      store.changed();
    });
}

function shortPath(p: string) {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : p;
}

function CtxMeter({ used, size }: { used: number; size: number }) {
  const pct = ctxPct(used, size);
  return (
    <span className={`ctx ${pct > 85 ? "hot" : pct > 60 ? "warm" : ""}`} title={`context ${used.toLocaleString()} / ${size.toLocaleString()} tokens`}>
      <span className="bar" style={{ width: `${Math.min(100, pct)}%` }} />
      <span className="lbl">{pct}%</span>
    </span>
  );
}

/** Commands hive itself handles in the composer ("/" menu). */
const HIVE_SLASH: { name: string; description: string; hint?: string }[] = [{ name: "improve", description: "turn a rough idea into a full prompt for this agent (✦)", hint: "rough idea" }];

function ConfigSelectors({ agent }: { agent: AgentView }) {
  const opts = agent.config.filter((o) => o.type === "select" && o.options?.length);
  if (!opts.length) return null;
  return (
    <span className="cfg" onDoubleClick={(e) => e.stopPropagation()}>
      {opts.map((o) => (
        <select
          key={o.id}
          value={String(o.currentValue)}
          title={o.name}
          onChange={(e) =>
            void rpc("setConfig", { name: agent.name, configId: o.id, value: e.target.value }).catch((err) =>
              store.toast(`${o.name}: ${err.message}`, "error"),
            )
          }
        >
          {o.options!.map((v) => (
            <option key={v.value} value={v.value}>
              {v.name}
            </option>
          ))}
        </select>
      ))}
    </span>
  );
}

// ---- transcript ----

export const Transcript = memo(function Transcript({ name }: { name: string }) {
  const pane = usePane(name);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  return (
    <div
      className="transcript"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {pane.items.length === 0 && <div className="empty">Type below to talk to {name}. Esc cancels a turn; ↑ recalls your last prompt.</div>}
      {foldTurns(pane.items).map((b) =>
        b.work ? (
          <details className="worked" key={"w" + b.work[0].id}>
            <summary>
              {b.ms !== undefined ? `Worked for ${duration(b.ms)}` : "Work"} · {b.work.length} step{b.work.length === 1 ? "" : "s"}
            </summary>
            <div className="worked-body">
              {b.work.map((it) => (
                <ItemView key={it.id} item={it} rev={it.rev} name={name} />
              ))}
            </div>
          </details>
        ) : (
          <ItemView key={b.item.id} item={b.item} rev={b.item.rev} name={name} />
        ),
      )}
    </div>
  );
});

type Block = { item: Item; work?: undefined } | { work: Item[]; ms?: number; item?: undefined };

/**
 * Finished turns fold their tool calls and thinking into one "Worked for 1m 12s"
 * line (as in T3 Code), so the answer is what you see. The running turn stays open.
 */
function foldTurns(items: Item[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < items.length) {
    let end = i;
    while (end < items.length && items[end].k !== "turn" && !(items[end].k === "user" && end > i)) end++;
    if (end === items.length) end = -1;
    if (end < 0 || items[end].k !== "turn") {
      // unfinished turn (or a turn without an end marker): show as is up to the next user prompt
      const stop = end < 0 ? items.length : end;
      for (; i < stop; i++) out.push({ item: items[i] });
      continue;
    }
    const seg = items.slice(i, end + 1);
    const work = seg.filter((x) => x.k === "tool" || x.k === "thought");
    if (work.length < 2) for (const x of seg) out.push({ item: x });
    else {
      const start = seg[0].k === "user" ? seg[0].ts : undefined;
      const fin = items[end] as Item & { k: "turn" };
      let placed = false;
      for (const x of seg) {
        if (x.k === "tool" || x.k === "thought") {
          if (!placed) out.push({ work, ms: start ? fin.ts - start : undefined });
          placed = true;
        } else out.push({ item: x });
      }
    }
    i = end + 1;
  }
  return out;
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return ms < 1000 ? "<1s" : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const ItemView = memo(function ItemView({ item, name }: { item: Item; rev: number; name: string }) {
  switch (item.k) {
    case "user": {
      // Prompts hive wrote (mail wake-ups, job runs, follow-ups) collapse to one quiet line.
      const auto = autoPromptLabel(item.text);
      if (auto)
        return (
          <details className="sys">
            <summary>{auto}</summary>
            <div className="sys-body">{item.text}</div>
          </details>
        );
      return <div className="msg user">{item.text}</div>;
    }
    case "agent":
      return <div className="msg agent md" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }} />;
    case "thought":
      return (
        <details className="thought">
          <summary>thinking…</summary>
          <div>{item.text}</div>
        </details>
      );
    case "tool": {
      // hive's own bookkeeping tools (mail, status, board) get one muted line, not a card.
      const quiet = hiveToolLine(item.title, item.status);
      if (quiet) return <div className={`tool-line ${item.status}`}>{quiet}</div>;
      return <ToolCard item={item} />;
    }
    case "plan":
      return (
        <ul className="plan">
          {item.entries.map((e, i) => (
            <li key={i} className={e.status}>
              <span className="box">{e.status === "completed" ? "✓" : e.status === "in_progress" ? "▸" : "○"}</span>
              {e.content}
            </li>
          ))}
        </ul>
      );
    case "permission":
      return (
        <PermissionCard
          ask={item.ask}
          decided={item.decided}
          onDecide={(d) => {
            item.decided = d;
            store.touch(name, item);
          }}
        />
      );
    case "elicitation":
      return (
        <ElicitationCard
          ask={item.ask}
          done={item.done}
          onDone={(d) => {
            item.done = d;
            store.touch(name, item);
          }}
        />
      );
    case "notice":
      return <div className={`notice ${item.level ?? ""}`}>{item.text}</div>;
    case "turn":
      return (
        <div className="turn">
          {item.stopReason === "end_turn" ? "done" : item.stopReason}
          {item.tokens ? ` · ${item.tokens.toLocaleString()} tok` : ""} · {new Date(item.ts).toLocaleTimeString()}
        </div>
      );
    case "session":
      return <div className="notice">session {item.how} · {item.sessionId.slice(0, 18)}</div>;
  }
});

function ToolCard({ item }: { item: Item & { k: "tool" } }) {
  const [open, setOpen] = useState(false);
  const diffs = item.content.filter((c) => c?.type === "diff");
  const texts = item.content.filter((c) => c?.type === "content" && c.content?.type === "text").map((c) => String(c.content.text));
  const hasBody = diffs.length > 0 || texts.length > 0 || item.rawInput != null;
  const loc = item.locations?.[0]?.path;
  return (
    <div className={`tool ${item.status}`}>
      <div
        className="tool-head"
        onClick={() => hasBody && setOpen(!open)}
        role={hasBody ? "button" : undefined}
        tabIndex={hasBody ? 0 : undefined}
        aria-expanded={hasBody ? open : undefined}
        onKeyDown={hasBody ? onActivate(() => setOpen(!open)) : undefined}
      >
        <span className="tstatus">{item.status === "completed" ? "✓" : item.status === "failed" ? "✗" : item.status === "in_progress" ? "…" : "○"}</span>
        <span className="tkind">{item.kind ?? "tool"}</span>
        <span className="ttitle">{item.title}</span>
        {loc && <span className="tloc code-link" data-path={loc} data-line={item.locations[0]?.line ?? undefined} title={`open ${loc} in the code view`}>{shortPath(loc)}</span>}
        {diffs.length > 0 && <span className="tdiff">{diffStat(diffs)}</span>}
        {hasBody && <span className="chev">{open ? "▾" : "▸"}</span>}
      </div>
      {open && (
        <div className="tool-body">
          {diffs.map((d, i) => (
            <Diff key={i} path={d.path} oldText={d.oldText ?? ""} newText={d.newText ?? ""} />
          ))}
          {texts.map((t, i) => (
            <pre key={i}>{t.slice(0, 20_000)}</pre>
          ))}
          {!diffs.length && !texts.length && item.rawInput != null && <pre>{JSON.stringify(item.rawInput, null, 2).slice(0, 5000)}</pre>}
        </div>
      )}
    </div>
  );
}

function diffRows(a: string, b: string): { t: " " | "+" | "-"; l: string }[] {
  const A = a ? a.split("\n") : [];
  const B = b ? b.split("\n") : [];
  let i = 0;
  while (i < A.length && i < B.length && A[i] === B[i]) i++;
  let j = 0;
  while (j < A.length - i && j < B.length - i && A[A.length - 1 - j] === B[B.length - 1 - j]) j++;
  const ctx = 3;
  return [
    ...A.slice(Math.max(0, i - ctx), i).map((l) => ({ t: " " as const, l })),
    ...A.slice(i, A.length - j).map((l) => ({ t: "-" as const, l })),
    ...B.slice(i, B.length - j).map((l) => ({ t: "+" as const, l })),
    ...A.slice(A.length - j, Math.min(A.length, A.length - j + ctx)).map((l) => ({ t: " " as const, l })),
  ];
}

function diffStat(diffs: any[]): string {
  let add = 0;
  let del = 0;
  for (const d of diffs)
    for (const r of diffRows(d.oldText ?? "", d.newText ?? "")) {
      if (r.t === "+") add++;
      if (r.t === "-") del++;
    }
  return `+${add} −${del}`;
}

function Diff({ path, oldText, newText }: { path: string; oldText: string; newText: string }) {
  const rows = diffRows(oldText, newText).slice(0, 600);
  return (
    <div className="diff">
      <div className="diff-path code-link" data-path={path} title={`open ${path} in the code view`}>{path}</div>
      <pre>
        {rows.map((r, i) => (
          <div key={i} className={r.t === "+" ? "add" : r.t === "-" ? "del" : "ctx"}>
            {r.t} {r.l}
          </div>
        ))}
      </pre>
    </div>
  );
}

function PermissionCard({ ask, decided, onDecide }: { ask: PermissionAsk; decided?: string; onDecide: (d: string) => void }) {
  const [done, setDone] = useState(decided);
  useEffect(() => setDone(decided), [decided]);
  const choose = (optionId: string, label: string) => {
    onDecide(label);
    setDone(label);
    void rpc("answerPermission", { reqId: ask.reqId, optionId }).catch((e) => store.toast(e.message, "error"));
  };
  return (
    <div className={`ask perm${done ? " done" : ""}`}>
      <div className="ask-title"><IconLock size={14} /> {ask.title}{ask.kind ? <span className="tkind"> {ask.kind}</span> : null}</div>
      {ask.detail && <pre className="ask-detail">{ask.detail}</pre>}
      {done ? (
        <div className="ask-done">→ {done}</div>
      ) : (
        <div className="ask-options">
          {ask.options.map((o) => (
            <button key={o.optionId} className={o.kind.startsWith("allow") ? "allow" : "reject"} onClick={() => choose(o.optionId, o.name)}>
              {o.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ElicitationCard({ ask, done, onDone }: { ask: ElicitationAsk; done?: string; onDone: (d: string) => void }) {
  const [vals, setVals] = useState<Record<string, string | boolean>>({});
  const [fin, setFin] = useState(done);
  useEffect(() => setFin(done), [done]);
  const finish = (action: "accept" | "decline" | "cancel") => {
    const content: Record<string, unknown> = {};
    for (const f of ask.fields) {
      const v = vals[f.key];
      if (v === undefined || v === "") continue;
      content[f.key] = f.type === "number" || f.type === "integer" ? Number(v) : f.type === "array" ? String(v).split(",").map((s) => s.trim()) : v;
    }
    onDone(action);
    setFin(action);
    void rpc("answerElicitation", { reqId: ask.reqId, action, content });
  };
  return (
    <div className={`ask elicit${fin ? " done" : ""}`}>
      <div className="ask-title">? {ask.message}</div>
      {ask.url && (
        <a href={ask.url} target="_blank" rel="noreferrer">
          {ask.url}
        </a>
      )}
      {fin ? (
        <div className="ask-done">→ {fin}</div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            finish("accept");
          }}
        >
          {ask.fields.map((f) => (
            <label key={f.key}>
              <span>
                {f.title}
                {f.required ? " *" : ""}
              </span>
              {f.type === "boolean" ? (
                <input type="checkbox" checked={!!vals[f.key]} onChange={(e) => setVals({ ...vals, [f.key]: e.target.checked })} />
              ) : f.choices ? (
                <select value={String(vals[f.key] ?? "")} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}>
                  <option value="" />
                  {f.choices.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              ) : (
                <input value={String(vals[f.key] ?? "")} placeholder={f.description} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />
              )}
            </label>
          ))}
          <div className="ask-options">
            <button type="submit" className="allow">Send</button>
            <button type="button" className="reject" onClick={() => finish("decline")}>Decline</button>
          </div>
        </form>
      )}
    </div>
  );
}

// ---- input ----

function Composer({ name, agent }: { name: string; agent?: AgentView }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const histIdx = useRef<number | null>(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (ref.current) focus.register(name, ref.current);
    return () => focus.unregister(name);
  }, [name]);
  // A new agent's pane was asked for focus while its input was still disabled.
  const usable = !!agent;
  useEffect(() => {
    if (usable) focus.ready(name);
  }, [usable, name]);
  // ✦ improve: rough draft → full prompt for this agent, written by a hidden helper (core/improve.ts)
  const [improving, setImproving] = useState(false);
  const [undo, setUndo] = useState<string | null>(null);
  const improve = (draft = text) => {
    if (!agent || improving) return;
    if (!draft.trim()) {
      // an empty box: say what ✦ does instead of looking dead
      ref.current?.focus();
      store.toast("✦ improve: type a rough idea first (e.g. \"fix the login bug\"), then press ✦ and hive writes it out as a full prompt for this agent");
      return;
    }
    setImproving(true);
    rpc("improvePrompt", { name, draft })
      .then(({ prompt }) => {
        setUndo(draft);
        setText(prompt);
        setTimeout(() => {
          const el = ref.current;
          if (el) (el.focus(), el.setSelectionRange(el.value.length, el.value.length));
        }, 0);
      })
      .catch((e) => store.toast(`couldn't improve the prompt: ${e.message}`, "error"))
      .finally(() => setImproving(false));
  };
  const send = (raw = text) => {
    const t = raw.trim();
    if (!t || !agent) return;
    // "/improve rough idea" does the same as the ✦ button
    const m = t.match(/^\/improve\s+([\s\S]+)/);
    if (m) return improve(m[1]);
    setUndo(null);
    const p = store.pane(name);
    p.history.push(t);
    histIdx.current = null;
    setText("");
    void rpc("prompt", { name, text: t }).catch((e) => store.toast(e.message, "error"));
  };
  useVoiceTarget(name, { el: () => ref.current, setText, send });
  // "/" menu: hive's own commands plus the ones the agent advertised (ACP available commands)
  const [slashSel, setSlashSel] = useState(0);
  const [slashOff, setSlashOff] = useState<string | null>(null);
  const slashQ = text.startsWith("/") && !/\s/.test(text) && slashOff !== text ? text.slice(1).toLowerCase() : null;
  const slashItems = useMemo(() => {
    if (slashQ == null) return [];
    const all = [...HIVE_SLASH, ...(agent?.commands ?? []).filter((c) => !HIVE_SLASH.some((h) => h.name === c.name))];
    const starts = all.filter((c) => c.name.toLowerCase().startsWith(slashQ));
    const has = all.filter((c) => !c.name.toLowerCase().startsWith(slashQ) && c.name.toLowerCase().includes(slashQ));
    return [...starts, ...has].slice(0, 12);
  }, [slashQ, agent?.commands]);
  const pickSlash = (c: { name: string }) => {
    setText(`/${c.name} `);
    setSlashSel(0);
    setTimeout(() => ref.current?.focus(), 0);
  };
  return (
    <div className="composer">
      {editing && (
        <PromptEditor
          agent={name}
          initial={text}
          onClose={(draft) => {
            setText(draft);
            setEditing(false);
            setTimeout(() => ref.current?.focus(), 0);
          }}
          onSend={(t) => {
            setEditing(false);
            send(t);
          }}
        />
      )}
      {slashItems.length > 0 && (
        <div className="slash-menu" role="listbox" aria-label="commands">
          {slashItems.map((c, i) => (
            <button
              key={c.name}
              role="option"
              aria-selected={i === Math.min(slashSel, slashItems.length - 1)}
              className={i === Math.min(slashSel, slashItems.length - 1) ? "on" : ""}
              onMouseDown={(e) => (e.preventDefault(), pickSlash(c))}
            >
              <span className="slash-name">/{c.name}</span>
              {c.hint && <span className="slash-hint">{c.hint}</span>}
              <span className="slash-desc">{c.description}</span>
            </button>
          ))}
        </div>
      )}
      <div className="composer-box">
      <textarea
        ref={ref}
        value={text}
        rows={Math.min(8, Math.max(1, text.split("\n").length))}
        placeholder={improving ? "writing a better prompt…" : agent ? (agent.status === "working" ? "agent is working — Enter queues, Esc cancels" : `message ${name}…  ✦ improves a rough idea`) : "starting…"}
        disabled={!agent || improving}
        onFocus={() => focus.setActive(name)}
        onChange={(e) => {
          setText(e.target.value);
          if (undo != null && e.target.value === "") setUndo(null);
        }}
        onKeyDown={(e) => {
          if (slashItems.length && ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key) && !e.shiftKey) {
            e.preventDefault();
            const cur = Math.min(slashSel, slashItems.length - 1);
            if (e.key === "ArrowDown") setSlashSel((cur + 1) % slashItems.length);
            else if (e.key === "ArrowUp") setSlashSel((cur - 1 + slashItems.length) % slashItems.length);
            else if (e.key === "Escape") setSlashOff(text);
            else pickSlash(slashItems[cur]);
            return;
          }
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "e") {
            e.preventDefault();
            setEditing(true);
          } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && e.shiftKey) {
            e.preventDefault();
            improve();
          } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && undo != null && !e.shiftKey) {
            // first Ctrl+Z after an improve brings the draft back
            e.preventDefault();
            setText(undo);
            setUndo(null);
          } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          } else if (e.key === "Escape") {
            if (agent?.status === "working") void rpc("cancel", { name });
          } else if (e.key === "ArrowUp" && (text === "" || histIdx.current != null) && !text.includes("\n")) {
            const h = store.pane(name).history;
            if (!h.length) return;
            e.preventDefault();
            histIdx.current = histIdx.current == null ? h.length - 1 : Math.max(0, histIdx.current - 1);
            setText(h[histIdx.current]);
          } else if (e.key === "ArrowDown" && histIdx.current != null) {
            const h = store.pane(name).history;
            e.preventDefault();
            histIdx.current++;
            if (histIdx.current >= h.length) {
              histIdx.current = null;
              setText("");
            } else setText(h[histIdx.current]);
          }
        }}
      />
      <div className="composer-bar">
      {agent && <ConfigSelectors agent={agent} />}
      <span className="spacer" />
      {undo != null && (
        <button className="ghost improve-undo" onClick={() => (setText(undo), setUndo(null))} title="back to your draft (Ctrl+Z)">
          undo
        </button>
      )}
      <button
        className={`ghost improve${improving ? " busy" : ""}`}
        onClick={() => improve()}
        disabled={!agent || improving}
        title="improve: turn this rough idea into a full prompt for this agent, then edit and send it here (Ctrl+Shift+Enter, or start with /improve)"
        aria-label="improve prompt"
      >
        <IconSpark />
      </button>
      <MicButton target={name} disabled={!agent} />
      <button className="ghost expand" onClick={() => setEditing(true)} disabled={!agent} title="open the big editor for long prompts (Ctrl+E)" aria-label="open prompt editor">
        <IconExpand />
      </button>
      <button className="send" onClick={() => send()} disabled={!agent || !text.trim()} title="send (Enter)">
        <IconSend />
      </button>
      </div>
      </div>
    </div>
  );
}
