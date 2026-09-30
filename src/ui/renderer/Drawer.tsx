/**
 * The Hive drawer: what happened while you were away, mail agents sent you,
 * the shared blackboard, all mail, and a box to message agents as the owner.
 */
import { useEffect, useState } from "react";
import type { Report } from "../../core/report.js";
import { rpc } from "./bridge.js";
import { store, useStore } from "./store.js";
import { fmtIdle } from "./format.js";

type Tab = "report" | "inbox" | "board" | "mail";
type HiveData = Awaited<ReturnType<typeof rpc<"hiveData">>>;

const SINCE: [string, number][] = [
  ["1h", 3_600_000],
  ["12h", 12 * 3_600_000],
  ["24h", 24 * 3_600_000],
  ["7d", 7 * 86_400_000],
];

export function Drawer({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>(store.ownerUnread ? "inbox" : "report");
  const [data, setData] = useState<HiveData | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [since, setSince] = useState(12 * 3_600_000);
  const unread = useStore((s) => s.ownerUnread);
  const refresh = () => {
    void rpc("hiveData", {}).then(setData).catch((e) => store.toast(e.message, "error"));
    void rpc("report", { sinceMs: since }).then(setReport).catch((e) => store.toast(e.message, "error"));
  };
  useEffect(refresh, [since, unread]);
  useEffect(() => {
    if (tab === "inbox" && unread) void rpc("markOwnerRead", {});
  }, [tab, unread]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const inbox = data?.messages.filter((m) => m.to_agent === "owner") ?? [];
  return (
    <aside className="drawer modal" aria-label="Hive">
      <div className="drawer-head">
        <strong>Hive</strong>
        <div className="seg">
          {(["report", "inbox", "board", "mail"] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
              {t === "report" ? "Since you left" : t === "inbox" ? `Inbox${unread ? ` (${unread})` : ""}` : t === "board" ? "Blackboard" : "All mail"}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button className="ghost" onClick={refresh} title="refresh">↻</button>
        <button className="ghost" onClick={onClose} title="close (Esc)">✕</button>
      </div>
      <div className="drawer-body">
        {tab === "report" && (
          <>
            <div className="row1">
              <span className="dim">window:</span>
              {SINCE.map(([l, ms]) => (
                <button key={l} className={`ghost small${since === ms ? " on" : ""}`} onClick={() => setSince(ms)}>
                  {l}
                </button>
              ))}
            </div>
            {report ? <ReportView r={report} /> : <div className="dim">loading…</div>}
          </>
        )}
        {tab === "inbox" && (
          <>
            {!inbox.length && <div className="dim pad">No mail. Agents write here with hive_send to "owner".</div>}
            {inbox.map((m) => (
              <Mail key={m.id} m={m} />
            ))}
          </>
        )}
        {tab === "board" && <Board rows={data?.blackboard ?? []} onChange={refresh} />}
        {tab === "mail" && (
          <>
            {(data?.messages ?? []).map((m) => (
              <Mail key={m.id} m={m} />
            ))}
          </>
        )}
      </div>
      <Compose agents={data?.agents ?? []} onSent={refresh} />
    </aside>
  );
}

function ReportView({ r }: { r: Report }) {
  return (
    <div className="report">
      {r.waiting.length > 0 && (
        <section>
          <h3>Needs you</h3>
          {r.waiting.map((w) => (
            <div key={w.agent}>
              <strong>{w.agent}</strong> <span className="dim">{w.note}</span>
            </div>
          ))}
        </section>
      )}
      <section>
        <h3>Jobs</h3>
        {!r.jobs.length && <div className="dim">No job runs in this window.</div>}
        {r.jobs.map((j) => (
          <div key={j.id} className="rep-job">
            <div>
              <strong>#{j.id}</strong> <span className="kind">{j.kind}</span> {j.agent} —{" "}
              <span className="ok">{j.ok} ok</span>
              {j.failed ? <span className="err"> · {j.failed} failed</span> : null}
              {j.limited ? <span className="warn"> · {j.limited} paused (usage limit)</span> : null}
              {j.tokens ? <span className="dim"> · {j.tokens.toLocaleString()} tok</span> : null}
            </div>
            <div className="dim small">{j.prompt.slice(0, 160)}</div>
            {j.lastSummary && <pre className="rep-sum">{j.lastSummary.slice(-1200)}</pre>}
            {j.lastError && <div className="err small">{j.lastError.slice(0, 300)}</div>}
          </div>
        ))}
      </section>
      {r.commits.length > 0 && (
        <section>
          <h3>Commits on agent branches</h3>
          {r.commits.map((c) => (
            <div key={c.repo + c.branch}>
              <span className="branch">⎇ {c.branch}</span> <span className="dim">({c.lines.length})</span>
              <pre className="rep-sum">{c.lines.slice(0, 15).join("\n")}</pre>
            </div>
          ))}
        </section>
      )}
      {r.blackboard.length > 0 && (
        <section>
          <h3>Blackboard changes</h3>
          {r.blackboard.map((b) => (
            <div key={b.key}>
              <strong>{b.key}</strong> <span className="dim">{b.by}</span> — {b.value.slice(0, 200)}
            </div>
          ))}
        </section>
      )}
      <div className="dim small">{r.mailCount} hive messages exchanged.</div>
    </div>
  );
}

function Mail({ m }: { m: HiveData["messages"][number] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`mail${m.to_agent === "owner" && m.read_at == null ? " unread" : ""}`} onClick={() => setOpen(!open)}>
      <div className="row1">
        <strong>{m.from_agent}</strong>
        <span className="dim">→ {m.to_agent === "*" ? "all" : m.to_agent}</span>
        <span className="subj">{m.subject}</span>
        <span className="spacer" />
        <span className="dim small">{fmtIdle(Date.now() - m.ts)} ago</span>
      </div>
      <div className={open ? "mail-body" : "mail-body clip"}>{m.body}</div>
    </div>
  );
}

function Board({ rows, onChange }: { rows: HiveData["blackboard"]; onChange: () => void }) {
  const [filter, setFilter] = useState("");
  const prefixes = [...new Set(rows.filter((r) => r.key.includes("/")).map((r) => r.key.split("/")[0]))];
  const shown = rows.filter((r) => r.key.startsWith(filter));
  return (
    <>
      <div className="row1">
        <button className={`ghost small${!filter ? " on" : ""}`} onClick={() => setFilter("")}>all</button>
        {prefixes.map((p) => (
          <button key={p} className={`ghost small${filter === p + "/" ? " on" : ""}`} onClick={() => setFilter(p + "/")}>
            {p}/
          </button>
        ))}
      </div>
      {!shown.length && <div className="dim pad">Empty. Agents write shared facts here (ideas/, security/, claim/…).</div>}
      {shown.map((r) => (
        <div key={r.key} className="bb-row">
          <div className="row1">
            <strong>{r.key}</strong>
            <span className="dim small">
              {r.updated_by} · {fmtIdle(Date.now() - r.updated_at)} ago
            </span>
            <span className="spacer" />
            <button
              className="ghost small"
              title="delete"
              onClick={() => {
                if (confirm(`Delete ${r.key}?`)) void rpc("bbDelete", { key: r.key }).then(onChange);
              }}
            >
              ✕
            </button>
          </div>
          <div className="mail-body">{r.value}</div>
        </div>
      ))}
    </>
  );
}

function Compose({ agents, onSent }: { agents: string[]; onSent: () => void }) {
  const [to, setTo] = useState("");
  const [body, setBody] = useState("");
  const send = () => {
    if (!to || !body.trim()) return;
    void rpc("sendMail", { to, body })
      .then(() => {
        store.toast(`mail sent to ${to === "*" ? "everyone" : to}`);
        setBody("");
        onSent();
      })
      .catch((e) => store.toast(e.message, "error"));
  };
  return (
    <div className="compose">
      <select value={to} onChange={(e) => setTo(e.target.value)} title="recipient">
        <option value="">to…</option>
        <option value="*">everyone</option>
        {agents.map((a) => (
          <option key={a}>{a}</option>
        ))}
      </select>
      <input
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && send()}
        placeholder="message as owner (agents are woken to read it, even ones not on screen)"
      />
      <button onClick={send} disabled={!to || !body.trim()}>Send</button>
    </div>
  );
}
