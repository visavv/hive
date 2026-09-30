import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentView, ElicitationAsk, PermissionAsk } from "../protocol.js";
import { rpc } from "./bridge.js";
import { renderMarkdown } from "./markdown.js";
import { store, usePane, useStore, type Item } from "./store.js";
import { focus } from "./focus.js";
import { ctxPct, fmtIdle, statusLabel } from "./format.js";

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
  const status = agent?.status ?? (starting?.error ? "error" : "starting");

  return (
    <section
      className={`pane status-${status}${waiting ? " needs-you" : ""}`}
      data-pane={name}
      onMouseEnter={() => hoverFocus && focus.hover(name)}
      onMouseDown={() => focus.setActive(name)}
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
        <span className="idx">{index < 9 ? `^${index + 1}` : ""}</span>
        <span className={`dot ${status}`} title={statusLabel(status)} />
        <strong className="pname">{name}</strong>
        <span className="kind">{agent?.kind ?? starting?.kind}</span>
        {agent && <ConfigSelectors agent={agent} />}
        <span className="spacer" />
        {agent?.ctx && <CtxMeter used={agent.ctx.used} size={agent.ctx.size} />}
        {agent && agent.queued > 0 && <span className="badge" title="prompts queued">{agent.queued} queued</span>}
        {agent && agent.jobs > 0 && <span className="badge job" title="scheduled jobs on this agent">⏱{agent.jobs}</span>}
        <div className="pane-actions" onDoubleClick={(e) => e.stopPropagation()}>
          {agent && status === "working" && (
            <button onClick={() => void rpc("cancel", { name })} title="cancel turn (Esc)">■</button>
          )}
          {agent && (
            <button onClick={onJob} title="schedule a loop / interval / watch job">⏱</button>
          )}
          {agent && (
            <button
              onClick={() => void rpc("newSession", { name }).catch((e) => store.toast(e.message, "error"))}
              title="fresh session (clears context)"
            >
              ⟲
            </button>
          )}
          <button onClick={onMaximize} title="maximize / restore">⤢</button>
          <button className="close" onClick={() => closePane(name)} title="close pane">✕</button>
        </div>
      </header>
      {agent && (
        <div className="pane-sub" title={agent.cwd}>
          {/[\\/]\.hive[\\/]worktrees[\\/]/.test(agent.cwd) ? (
            <span className="branch">⎇ hive/{agent.cwd.split(/[\\/]/).pop()}</span>
          ) : (
            <span>{shortPath(agent.cwd)}</span>
          )}
          {agent.role && <span>· {agent.role}</span>}
          <span>· {agent.policy}</span>
          {agent.auth && <span className={agent.auth === "not logged in" ? "warn" : ""}>· {agent.auth}</span>}
          <span className="spacer" />
          <span className="note">{agent.note}</span>
          {status === "idle" && <span>idle {fmtIdle(agent.idleMs)}</span>}
        </div>
      )}
      <Transcript name={name} />
      {starting?.error ? (
        <div className="pane-error">
          Could not start: {starting.error}
          <button onClick={() => retry(name)}>Retry</button>
        </div>
      ) : (
        <Composer name={name} agent={agent} />
      )}
    </section>
  );
}

function closePane(name: string) {
  const l = store.layout;
  store.layout = { ...l, panes: l.panes.filter((p) => p.name !== name), maximized: l.maximized === name ? null : l.maximized };
  store.starting.delete(name);
  store.panes.delete(name);
  store.bump();
  void rpc("saveLayout", store.layout);
  void rpc("removeAgent", { name }).catch(() => {});
}

function retry(name: string) {
  const spec = store.layout.panes.find((p) => p.name === name);
  if (!spec) return;
  store.starting.set(name, { kind: spec.kind });
  store.bump();
  rpc("addAgent", { ...spec, resume: true })
    .then(() => {
      store.starting.delete(name);
      store.bump();
    })
    .catch((e) => {
      store.starting.set(name, { kind: spec.kind, error: e.message });
      store.bump();
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

const Transcript = memo(function Transcript({ name }: { name: string }) {
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
      {pane.items.map((it, i) => (
        <ItemView key={i} item={it} v={itemVersion(it)} />
      ))}
    </div>
  );
});

function itemVersion(it: Item): string {
  switch (it.k) {
    case "agent":
    case "thought":
      return String(it.text.length);
    case "tool":
      return `${it.status}:${it.content.length}:${it.title}`;
    case "plan":
      return JSON.stringify(it.entries.map((e) => e.status));
    case "permission":
      return it.decided ?? "";
    case "elicitation":
      return it.done ?? "";
    default:
      return "";
  }
}

const ItemView = memo(function ItemView({ item }: { item: Item; v: string }) {
  switch (item.k) {
    case "user":
      return <div className={`msg user${item.text.startsWith("You have ") || item.text.startsWith("[hive job") ? " auto" : ""}`}>{item.text}</div>;
    case "agent":
      return <div className="msg agent md" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }} />;
    case "thought":
      return (
        <details className="thought">
          <summary>thinking…</summary>
          <div>{item.text}</div>
        </details>
      );
    case "tool":
      return <ToolCard item={item} />;
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
      return <PermissionCard ask={item.ask} decided={item.decided} onDecide={(d) => (item.decided = d)} />;
    case "elicitation":
      return <ElicitationCard ask={item.ask} done={item.done} onDone={(d) => (item.done = d)} />;
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
      return <div className="notice">session {item.how} · {item.id.slice(0, 18)}</div>;
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
      <div className="tool-head" onClick={() => hasBody && setOpen(!open)}>
        <span className="tstatus">{item.status === "completed" ? "✓" : item.status === "failed" ? "✗" : item.status === "in_progress" ? "…" : "○"}</span>
        <span className="tkind">{item.kind ?? "tool"}</span>
        <span className="ttitle">{item.title}</span>
        {loc && <span className="tloc">{shortPath(loc)}</span>}
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
  const A = a.split("\n");
  const B = b.split("\n");
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
      <div className="diff-path">{path}</div>
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
    void rpc("answerPermission", { reqId: ask.reqId, optionId });
  };
  return (
    <div className={`ask perm${done ? " done" : ""}`}>
      <div className="ask-title">🔐 {ask.title}{ask.kind ? <span className="tkind"> {ask.kind}</span> : null}</div>
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
  useEffect(() => {
    if (ref.current) focus.register(name, ref.current);
    return () => focus.unregister(name);
  }, [name]);
  const send = () => {
    const t = text.trim();
    if (!t || !agent) return;
    const p = store.pane(name);
    p.history.push(t);
    histIdx.current = null;
    setText("");
    void rpc("prompt", { name, text: t }).catch((e) => store.toast(e.message, "error"));
  };
  return (
    <div className="composer">
      <textarea
        ref={ref}
        value={text}
        rows={Math.min(8, Math.max(1, text.split("\n").length))}
        placeholder={agent ? (agent.status === "working" ? "agent is working — Enter queues, Esc cancels" : `message ${name}…`) : "starting…"}
        disabled={!agent}
        onFocus={() => focus.setActive(name)}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
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
      <button className="send" onClick={send} disabled={!agent || !text.trim()} title="send (Enter)">
        ➤
      </button>
    </div>
  );
}
