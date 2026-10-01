/**
 * Verdict mode: one prompt to two or more agents at once; a judge compares
 * the results blind, finds bugs and decides what to take from each; then one
 * click has the base solution's author build the merged version.
 */
import { useEffect, useState } from "react";
import type { VerdictState } from "../../core/verdict.js";
import { rpc } from "./bridge.js";
import { store, useStore } from "./store.js";
import { Modal } from "./App.js";
import { renderMarkdown } from "./markdown.js";

export function VerdictWindow() {
  const open = useStore((s) => s.verdictOpen);
  if (open == null) return null;
  return typeof open === "number" ? <VerdictView id={open} /> : <VerdictSetup initial={open.prompt ?? ""} />;
}

function VerdictSetup({ initial }: { initial: string }) {
  const kinds = useStore((s) => s.kinds);
  const [prompt, setPrompt] = useState(initial);
  const [picked, setPicked] = useState<string[]>(() => kinds.filter((k) => ["claude", "codex"].includes(k.id) && !k.missing).map((k) => k.id));
  const [judge, setJudge] = useState(kinds.some((k) => k.id === "claude") ? "claude" : (kinds[0]?.id ?? ""));
  const [model, setModel] = useState("");
  const [mode, setMode] = useState<"code" | "text">("code");
  const [policy, setPolicy] = useState<"allow-all" | "ask">("allow-all");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [past, setPast] = useState<VerdictState[]>([]);
  useEffect(() => void rpc("verdicts", {}).then(setPast).catch(() => {}), []);
  const toggle = (id: string) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  const start = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await rpc("startVerdict", { prompt, kinds: picked, judge, judgeModel: model, mode, policy: mode === "code" ? policy : "reject-all" });
      store.openVerdict(r.id);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Verdict: several agents, one judge" onClose={() => store.openVerdict(null)} wide>
      <p className="dim small">
        Each agent you pick solves the same prompt at the same time{mode === "code" ? ", in its own git worktree" : ""}. Then the judge compares the results without knowing who wrote which, finds bugs, and decides what to take from each. It costs
        one turn per agent plus one for the judge.
      </p>
      <textarea className="prompt-editor verdict-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What should they build or answer?" aria-label="prompt" autoFocus />
      <div className="verdict-grid">
        <fieldset className="modes">
          <legend>Contenders ({picked.length})</legend>
          {kinds.map((k) => (
            <label key={k.id} className="radio" title={k.missing ? `${k.missing} is not set` : k.label}>
              <input type="checkbox" checked={picked.includes(k.id)} onChange={() => toggle(k.id)} /> {k.label}
              {k.missing && <span className="warn small"> (needs {k.missing})</span>}
            </label>
          ))}
        </fieldset>
        <div className="form">
          <label>
            <span>Judge</span>
            <select value={judge} onChange={(e) => setJudge(e.target.value)}>
              {kinds.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Judge model</span>
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="optional, e.g. the strongest model id" />
          </label>
          <div className="seg" role="group" aria-label="mode">
            <button type="button" className={mode === "code" ? "on" : ""} onClick={() => setMode("code")} title="each agent writes code in its own worktree">
              Code
            </button>
            <button type="button" className={mode === "text" ? "on" : ""} onClick={() => setMode("text")} title="compare answers (titles, plans, prompts…)">
              Text
            </button>
          </div>
          {mode === "code" && (
            <label>
              <span>Contenders may</span>
              <select value={policy} onChange={(e) => setPolicy(e.target.value as any)}>
                <option value="allow-all">edit and run freely (own worktree)</option>
                <option value="ask">ask me before edits</option>
              </select>
            </label>
          )}
        </div>
      </div>
      {err && <div className="err">{err}</div>}
      <div className="buttons">
        {past.length > 0 && (
          <select value="" onChange={(e) => e.target.value && store.openVerdict(Number(e.target.value))} aria-label="open a past verdict">
            <option value="">past verdicts…</option>
            {past.map((v) => (
              <option key={v.id} value={v.id}>
                #{v.id} {v.status} · {v.contenders.map((c) => c.kind).join(" vs ")} · {v.prompt.slice(0, 40)}
              </option>
            ))}
          </select>
        )}
        <span className="spacer" />
        <span className="dim small">{picked.length >= 2 ? `${picked.length + 1} agent turns` : "pick two or more"}</span>
        <button type="button" className="ghost" onClick={() => store.openVerdict(null)}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={busy || picked.length < 2 || !prompt.trim() || !judge} onClick={() => void start()}>
          {busy ? "Starting…" : "Start"}
        </button>
      </div>
    </Modal>
  );
}

function VerdictView({ id }: { id: number }) {
  const live = useStore((s) => s.verdicts.get(id));
  const [loaded, setLoaded] = useState<VerdictState | undefined>();
  const [label, setLabel] = useState("");
  useEffect(() => {
    if (!live) void rpc("verdicts", {}).then((l) => setLoaded(l.find((v) => v.id === id)));
  }, [id]);
  const v = live ?? loaded;
  if (!v) return <Modal title={`Verdict #${id}`} onClose={() => store.openVerdict(null)}>loading…</Modal>;
  const working = v.status === "running" || v.status === "judging" || v.status === "applying";
  const base = label || v.base || "";
  return (
    <Modal title={`Verdict #${v.id}`} onClose={() => store.openVerdict(null)} wide>
      <div className="dim small verdict-task">{v.prompt.slice(0, 400)}</div>
      <div className="verdict-contenders" aria-live="polite">
        {v.contenders.map((c) => (
          <div key={c.label} className={`vc ${c.status}${v.base === c.label ? " base" : ""}`}>
            <div className="row1">
              <strong>Solution {c.label}</strong>
              <span className="kind">{v.status === "running" ? "hidden" : c.kind}</span>
              <span className="spacer" />
              <span className={`vstat ${c.status}`}>{c.status}</span>
            </div>
            {c.branch && <div className="dim small">⎇ {c.branch}</div>}
            {c.diffStat && <pre className="rep-sum">{c.diffStat.split("\n").slice(-6).join("\n")}</pre>}
            {c.error && <div className="err small">{c.error}</div>}
            {c.ms ? <div className="dim small">{Math.round(c.ms / 1000)} s</div> : null}
          </div>
        ))}
        <div className={`vc judge ${v.status === "judging" ? "working" : v.verdict ? "done" : "waiting"}`}>
          <div className="row1">
            <strong>Judge</strong>
            <span className="kind">{v.judgeKind}</span>
            <span className="spacer" />
            <span className="vstat">{v.status === "judging" ? "comparing…" : v.verdict ? `base: ${v.base ?? "?"}` : "waiting"}</span>
          </div>
        </div>
      </div>
      {v.error && <div className="err">{v.error}</div>}
      {v.verdict && <div className="verdict-text md" dangerouslySetInnerHTML={{ __html: renderMarkdown(v.verdict) }} />}
      {v.applied && (
        <div className={v.applied.error ? "err small" : "ok small"}>
          {v.applied.error ? `apply failed: ${v.applied.error}` : v.status === "applying" ? `${v.applied.agent} is building the merged version…` : `built by ${v.applied.agent}. Review it in the sidebar's worktrees and merge.`}
        </div>
      )}
      <div className="buttons">
        <span className="dim small">{v.report ? `report: ${v.report}` : working ? "working… you can close this; you'll get a ping when it's ready" : ""}</span>
        <span className="spacer" />
        {v.status === "done" && (
          <>
            <select value={base} onChange={(e) => setLabel(e.target.value)} aria-label="build on solution">
              {v.contenders
                .filter((c) => c.status === "done")
                .map((c) => (
                  <option key={c.label} value={c.label}>
                    build on {c.label} ({c.kind}){v.base === c.label ? " ← judge's pick" : ""}
                  </option>
                ))}
            </select>
            <button className="primary" onClick={() => void rpc("applyVerdict", { id: v.id, label: base }).catch((e) => store.toast(e.message, "error"))} title="the author of that solution builds the merged version in its worktree, following the verdict">
              Build merged version
            </button>
          </>
        )}
        <button className="ghost" onClick={() => store.openVerdict({})}>
          New verdict
        </button>
      </div>
    </Modal>
  );
}
