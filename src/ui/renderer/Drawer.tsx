/**
 * The Hive drawer: what happened while you were away, mail agents sent you,
 * the shared blackboard, all mail, and a box to message agents as the owner.
 */
import { useEffect, useRef, useState } from "react";
import type { Report } from "../../core/report.js";
import { rpc } from "./bridge.js";
import { store, useStore } from "./store.js";
import { fmtIdle } from "./format.js";
import { useOverlay } from "./focus.js";
import { HeldList, PauseIcon } from "./Links.js";
import { VoiceAccounts } from "./Voice.js";

type Tab = "report" | "inbox" | "learn" | "board" | "mail" | "usage" | "accounts";
type Usage = Awaited<ReturnType<typeof rpc<"usage">>>;
type HiveData = Awaited<ReturnType<typeof rpc<"hiveData">>>;

const SINCE: [string, number][] = [
  ["1h", 3_600_000],
  ["12h", 12 * 3_600_000],
  ["24h", 24 * 3_600_000],
  ["7d", 7 * 86_400_000],
];

export function Drawer({ onClose, initialTab }: { onClose: () => void; initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab ?? (store.ownerUnread || store.heldTotal ? "inbox" : store.learnPending ? "learn" : "report"));
  const [data, setData] = useState<HiveData | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [since, setSince] = useState(12 * 3_600_000);
  const unread = useStore((s) => s.ownerUnread);
  const held = useStore((s) => s.heldTotal);
  const learn = useStore((s) => s.learnPending);
  const refresh = () => {
    void rpc("hiveData", {}).then(setData).catch((e) => store.toast(e.message, "error"));
    void rpc("report", { sinceMs: since }).then(setReport).catch((e) => store.toast(e.message, "error"));
  };
  useEffect(refresh, [since, unread]);
  useEffect(() => {
    if (tab === "inbox" && unread) void rpc("markOwnerRead", {});
  }, [tab, unread]);
  // Esc closes the drawer only (never the turn of the pane you came from): take
  // focus while open, give it back on close.
  useOverlay("drawer", onClose);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.focus({ preventScroll: true });
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);

  const inbox = data?.messages.filter((m) => m.to_agent === "owner") ?? [];
  return (
    <aside ref={ref} tabIndex={-1} className="drawer modal" aria-label="Hive">
      <div className="drawer-head">
        <strong>Hive</strong>
        <div className="seg">
          {(["report", "inbox", "learn", "board", "mail", "usage", "accounts"] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
              {t === "report" ? "Since you left" : t === "inbox" ? `Inbox${unread + held ? ` (${unread + held})` : ""}` : t === "learn" ? `Learning${learn ? ` (${learn})` : ""}` : t === "board" ? "Blackboard" : t === "usage" ? "Usage" : t === "accounts" ? "Accounts" : "All mail"}
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
            <HeldList />
            {!inbox.length && <div className="dim pad">No mail. Agents write here with hive_send to "owner".</div>}
            {inbox.map((m) => (
              <Mail key={m.id} m={m} />
            ))}
          </>
        )}
        {tab === "learn" && <LearnView />}
        {tab === "board" && <Board rows={data?.blackboard ?? []} onChange={refresh} />}
        {tab === "usage" && <UsageView />}
        {tab === "accounts" && <AccountsView />}
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

type Accounts = Awaited<ReturnType<typeof rpc<"accounts">>>;

/** Which agents are signed in on this machine (CLI logins) or have their API key set. */
export function AccountsView() {
  const [rows, setRows] = useState<Accounts | null>(null);
  const [busy, setBusy] = useState(false);
  const load = (refresh = false) => {
    setBusy(true);
    void rpc("accounts", { refresh })
      .then(setRows)
      .catch((e) => store.toast(e.message, "error"))
      .finally(() => setBusy(false));
  };
  useEffect(() => load(), []);
  const cmd = (s?: string) => s?.match(/`([^`]+)`/)?.[1];
  const groups: [string, Accounts][] = rows
    ? [
        ["Subscriptions (sign in once with the vendor's CLI on this machine)", rows.filter((r) => !r.api)],
        ["API keys (pay per token)", rows.filter((r) => r.api)],
      ]
    : [];
  return (
    <div className="accounts">
      <div className="row1">
        <span className="dim small">
          hive doesn't store logins. Each CLI keeps its own sign-in on this machine and hive asks it on start. API agents read their key from the environment.
        </span>
        <span className="spacer" />
        <button className="ghost small" onClick={() => load(true)} disabled={busy}>
          {busy ? "checking…" : "↻ check again"}
        </button>
      </div>
      {!rows && <div className="dim pad">checking each agent (a few seconds)…</div>}
      {groups.map(([title, list]) => (
        <section key={title}>
          <h3>{title}</h3>
          {list.map((r) => (
            <div key={r.id} className={`acct ${r.signedIn === true ? "ok" : r.signedIn === false ? "no" : "unk"}`}>
              <span className="acct-mark" aria-label={r.signedIn === true ? "ready" : r.signedIn === false ? "not ready" : "unknown"}>
                {r.signedIn === true ? "✓" : r.signedIn === false ? "✗" : "?"}
              </span>
              <div className="acct-main">
                <div className="row1">
                  <strong>{r.label}</strong>
                  <span className="kind">{r.id}</span>
                  <span className="dim small">{r.status}</span>
                </div>
                {r.signedIn !== true && (
                  <div className="small">
                    {r.installed === "missing" ? r.install : r.login}
                    {cmd(r.installed === "missing" ? r.install : r.login) && (
                      <button
                        className="ghost small"
                        onClick={() => void navigator.clipboard.writeText(cmd(r.installed === "missing" ? r.install : r.login)!).then(() => store.toast("copied — paste it in a terminal"))}
                      >
                        copy command
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </section>
      ))}
      <VoiceAccounts />
    </div>
  );
}

const kTok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const BUDGET_HELP: Record<string, string> = {
  daily_tokens: "all providers, per day (empty = no cap)",
  daily_tokens_api: "each pay-per-token API provider without its own cap (gemini-api, openrouter…)",
  reserve_pct: "stop automatic work when a subscription window is this full",
  max_concurrent: "automatic runs at once",
  media_daily: "image / voice API calls per day",
  paused: "1 = stop all automatic work",
};

/** Tokens per provider, subscription windows with reset countdowns, spending guards. */
export function UsageView() {
  const [u, setU] = useState<Usage | null>(null);
  const [, tick] = useState(0);
  const load = () => void rpc("usage", {}).then(setU).catch((e) => store.toast(e.message, "error"));
  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    const c = setInterval(() => tick((n) => n + 1), 1000);
    return () => {
      clearInterval(t);
      clearInterval(c);
    };
  }, []);
  const set = (key: string, value: string) =>
    void rpc("setBudget", { key, value })
      .then((r) => {
        setU(r);
        store.toast(`${key} ${value === "" ? "cleared" : `= ${value}`}`);
      })
      .catch((e) => store.toast(e.message, "error"));
  if (!u) return <div className="dim pad">loading…</div>;
  const paused = u.budget.paused === "1";
  return (
    <div className="usage">
      <div className={`usage-pause${paused ? " on" : ""}`}>
        <span>
          {paused && <PauseIcon />} {paused ? "Automatic work is paused (jobs, mail wake-ups). Your own prompts still run." : "Automatic work is running within the limits below."}
        </span>
        <span className="spacer" />
        <button className={paused ? "" : "danger"} onClick={() => set("paused", paused ? "0" : "1")}>
          {paused ? "Resume" : "Pause all automatic work"}
        </button>
      </div>
      {!u.providers.length && <div className="dim pad">No usage yet. Numbers appear after the first turn.</div>}
      {u.providers.map((p) => (
        <section key={p.provider} className="usage-prov">
          <div className="row1">
            <strong>{p.provider}</strong>
            <span className="dim small">
              5h {kTok(p.h5)} · today {kTok(p.d1)} · 7d {kTok(p.d7)} tok{p.cost7 ? ` · $${p.cost7.toFixed(2)} 7d (API-equivalent)` : ""}
            </span>
          </div>
          {p.limits.map((l) => {
            const pct = l.pct == null ? null : Math.min(100, Math.max(0, l.pct));
            const left = l.resetsAt ? Math.max(0, l.resetsAt - Date.now()) : null;
            const lvl = l.status === "rejected" || (pct ?? 0) >= 90 ? "err" : (pct ?? 0) >= 70 ? "warn" : "ok";
            return (
              <div key={l.window} className="usage-win">
                <span className="usage-label">{l.window.replace(/_/g, " ")}</span>
                <div className="usage-bar" title={pct == null ? (l.status ?? "") : `${Math.round(pct)}% used`}>
                  <div className={`usage-fill ${lvl}`} style={{ width: `${pct ?? (l.status === "rejected" ? 100 : 0)}%` }} />
                </div>
                <span className="small">{pct != null ? `${Math.max(0, 100 - Math.round(pct))}% left` : l.status === "rejected" ? "limit hit" : (l.status ?? "")}</span>
                <span className="dim small">{left != null ? `resets in ${fmtIdle(left)}` : ""}</span>
              </div>
            );
          })}
          {!p.limits.length && <div className="dim small">No limit window reported (Claude reports its 5-hour/weekly windows while it runs; others show a window once a limit is hit).</div>}
          {!p.guard.ok && <div className="warn small">automatic work held: {p.guard.reason}</div>}
        </section>
      ))}
      <div className="dim small">
        Media calls today: {u.media.today} / {u.media.cap}
      </div>
      <section>
        <h3>Spending guards</h3>
        <div className="dim small">Only automatic work (scheduled jobs, agents waking each other) is held. Values: 2m, 500k. Empty = default/off.</div>
        {Object.keys(BUDGET_HELP)
          .filter((k) => k !== "paused")
          .map((k) => (
            <BudgetRow key={k} k={k} value={u.budget[k] ?? ""} help={BUDGET_HELP[k]} onSet={set} />
          ))}
        {Object.entries(u.budget)
          .filter(([k]) => k.startsWith("daily_tokens."))
          .map(([k, v]) => (
            <BudgetRow key={k} k={k} value={v} help="per-provider daily cap" onSet={set} />
          ))}
        <BudgetRow k="" value="" help="add a per-provider cap, e.g. daily_tokens.claude" onSet={set} />
      </section>
    </div>
  );
}

function BudgetRow({ k, value, help, onSet }: { k: string; value: string; help: string; onSet: (k: string, v: string) => void }) {
  const [key, setKey] = useState(k);
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const dirty = v !== value || key !== k;
  return (
    <div className="budget-row">
      {k ? <code>{k}</code> : <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="daily_tokens.claude" aria-label="budget key" />}
      <input value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && dirty && key && onSet(key, v)} aria-label={`${key || "new"} value`} />
      <button className="ghost small" disabled={!dirty || !key} onClick={() => onSet(key, v)}>
        Save
      </button>
      <span className="dim small">{help}</span>
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

type LearnState = Awaited<ReturnType<typeof rpc<"learnState">>>;
const KIND_LABEL: Record<string, string> = { owner: "about you", project: "about this project", skill: "new skill", "forget-skill": "remove skill" };

/** Memory and learning: what hive remembers, and what it learned waiting for your OK. */
function LearnView() {
  const [st, setSt] = useState<LearnState | null>(null);
  const [busy, setBusy] = useState(false);
  const agents = useStore((s) => [...s.agents.keys()].filter((n) => !/^(pe|lr)-/.test(n)));
  const [who, setWho] = useState("");
  const act = (p: Promise<LearnState>) =>
    void p.then(setSt).catch((e) => store.toast(e.message, "error"));
  useEffect(() => act(rpc("learnState", {})), []);
  if (!st) return <div className="dim pad">loading…</div>;
  const reflectNow = () => {
    const agent = who || agents[0];
    if (!agent) return store.toast("start an agent first", "error");
    setBusy(true);
    void rpc("learnNow", { agent })
      .then((r) => {
        setSt(r);
        store.toast(r.added ? `${r.added} new suggestion${r.added === 1 ? "" : "s"} from ${agent}'s chat` : `nothing new to learn from ${agent}'s chat`);
      })
      .catch((e) => store.toast(e.message, "error"))
      .finally(() => setBusy(false));
  };
  return (
    <div className="learn">
      <div className="row1">
        <label className="learn-on">
          <input type="checkbox" checked={st.on} onChange={(e) => act(rpc("learnSettings", { on: e.target.checked }))} /> Learn from my sessions
        </label>
        <span className="dim small">after a few messages with an agent, a helper suggests what to remember (counts as "learning" in token stats)</span>
        <span className="spacer" />
        {agents.length > 0 && (
          <>
            <select value={who || agents[0]} onChange={(e) => setWho(e.target.value)} aria-label="agent to learn from">
              {agents.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
            <button className="ghost small" disabled={busy} onClick={reflectNow}>
              {busy ? "reading…" : "Learn from this chat now"}
            </button>
          </>
        )}
      </div>
      <h4>Waiting for your OK {st.pending.length ? `(${st.pending.length})` : ""}</h4>
      {!st.pending.length && <div className="dim pad">Nothing waiting. Suggestions appear here; nothing is remembered until you accept it.</div>}
      {st.pending.map((p) => (
        <Suggestion key={p.id} p={p} onDone={setSt} />
      ))}
      <MemoryList title="About you" hint="every project · e.g. “I make YouTube videos about coding for beginners”, “use PowerShell, not bash”" scope="owner" lines={st.owner} path={st.ownerPath} onChange={setSt} />
      <MemoryList title="About this project" hint="e.g. “tests: npm test”, “never touch render/”" scope="project" lines={st.project} path={st.projectPath} onChange={setSt} />
    </div>
  );
}

function Suggestion({ p, onDone }: { p: LearnState["pending"][number]; onDone: (s: LearnState) => void }) {
  const [text, setText] = useState(p.text);
  const decide = (accept: boolean) =>
    void rpc("learnDecide", { id: p.id, accept, text: accept && text !== p.text ? text : undefined })
      .then(onDone)
      .catch((e) => store.toast(e.message, "error"));
  const big = p.kind === "skill";
  return (
    <div className="bb-row learn-item" data-kind={p.kind}>
      <div className="row1">
        <strong>{KIND_LABEL[p.kind] ?? p.kind}{p.title ? `: ${p.title}` : ""}</strong>
        <span className="dim small">{[p.agent && `from ${p.agent}'s chat`, p.reason].filter(Boolean).join(" · ")}</span>
      </div>
      {p.kind === "forget-skill" ? (
        <div className="mail-body">{p.text}</div>
      ) : big ? (
        <textarea className="learn-edit mono" rows={8} value={text} onChange={(e) => setText(e.target.value)} aria-label="edit before accepting" />
      ) : (
        <input className="learn-edit" value={text} onChange={(e) => setText(e.target.value)} aria-label="edit before accepting" />
      )}
      <div className="row1">
        <button className="primary small" onClick={() => decide(true)}>{p.kind === "forget-skill" ? "Remove it" : "Accept"}</button>
        <button className="ghost small" onClick={() => decide(false)}>{p.kind === "forget-skill" ? "Keep it" : "Reject"}</button>
      </div>
    </div>
  );
}

function MemoryList({ title, hint, scope, lines, path, onChange }: { title: string; hint: string; scope: "owner" | "project"; lines: string[]; path: string; onChange: (s: LearnState) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    if (!draft.trim()) return;
    void rpc("memoryAdd", { scope, text: draft })
      .then((s) => {
        onChange(s);
        setDraft("");
      })
      .catch((e) => store.toast(e.message, "error"));
  };
  return (
    <div className={`memory memory-${scope}`}>
      <h4>
        {title} <span className="dim small" title={path}>{lines.length} · every agent reads this</span>
      </h4>
      {lines.map((l, i) => (
        <div key={i} className="row1 memory-line">
          <span>{l}</span>
          <span className="spacer" />
          <button className="ghost small" title="forget" aria-label={`forget: ${l}`} onClick={() => void rpc("memoryRemove", { scope, index: i }).then(onChange).catch((e) => store.toast(e.message, "error"))}>
            ✕
          </button>
        </div>
      ))}
      <div className="row1">
        <input value={draft} placeholder={hint} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} aria-label={`add to ${title}`} />
        <button className="ghost small" onClick={add}>Add</button>
      </div>
    </div>
  );
}
