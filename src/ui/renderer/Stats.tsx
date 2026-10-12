/**
 * Where your tokens went, across every project: by provider, model, kind of
 * work (coding, review, testing…), project or day. One series per view, bars
 * sized by share; numbers sit next to each bar so the list is also the table.
 */
import { useEffect, useState } from "react";
import { rpc } from "./bridge.js";
import { Modal } from "./Modal.js";
import { onActivate } from "./focus.js";
import { store } from "./store.js";

type Dim = "vendor" | "model" | "category" | "project" | "day";
type Result = Awaited<ReturnType<typeof rpc<"stats">>>;
const DIMS: [Dim, string][] = [
  ["vendor", "Provider"],
  ["model", "Model"],
  ["category", "Task"],
  ["project", "Project"],
  ["day", "Day"],
];
const RANGES: [number, string][] = [
  [1, "24h"],
  [7, "7 days"],
  [30, "30 days"],
  [90, "90 days"],
  [0, "All"],
];

export const fmtTokens = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

export function StatsDialog({ onClose }: { onClose: () => void }) {
  const [by, setBy] = useState<Dim>("vendor");
  const [days, setDays] = useState(30);
  const [filter, setFilter] = useState<{ vendor?: string; model?: string; category?: string; project?: string }>({});
  const [r, setR] = useState<Result | null>(null);
  useEffect(() => {
    rpc("stats", { by, filter: { ...filter, since: days ? Date.now() - days * 86_400_000 : undefined } })
      .then(setR)
      .catch((e) => store.toast(e.message, "error"));
  }, [by, days, JSON.stringify(filter)]);
  const set = (k: keyof typeof filter, v: string) => setFilter((f) => ({ ...f, [k]: v || undefined }));
  const max = Math.max(1, ...(r?.rows.map((x) => x.tokens) ?? [1]));
  return (
    <Modal title="Token stats" onClose={onClose} wide>
      <div className="stats">
        <div className="stats-filters">
          <div className="seg small" role="group" aria-label="time range">
            {RANGES.map(([d, l]) => (
              <button key={d} className={days === d ? "on" : ""} onClick={() => setDays(d)}>
                {l}
              </button>
            ))}
          </div>
          {(["vendor", "model", "category", "project"] as const).map((k) => (
            <select key={k} value={filter[k] ?? ""} onChange={(e) => set(k, e.target.value)} aria-label={`filter by ${k}`}>
              <option value="">{k === "vendor" ? "All providers" : k === "category" ? "All tasks" : `All ${k}s`}</option>
              {(r?.facets[k] ?? []).map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          ))}
        </div>
        <div className="stats-head">
          <div className="stats-total">
            <span className="big">{fmtTokens(r?.total.tokens ?? 0)}</span> tokens
            <span className="dim">
              {" "}
              · {r?.total.turns ?? 0} turns{r?.total.cost ? ` · $${r.total.cost.toFixed(2)} API-equivalent` : ""}
            </span>
          </div>
          <div className="seg small" role="tablist" aria-label="group by">
            {DIMS.map(([d, l]) => (
              <button key={d} role="tab" aria-selected={by === d} className={by === d ? "on" : ""} onClick={() => setBy(d)}>
                {l}
              </button>
            ))}
          </div>
        </div>
        {r && !r.rows.length && <p className="dim pad">Nothing recorded for this range yet. Every finished turn is logged from now on, in every project.</p>}
        {by === "day" ? (
          <div className="stats-days" role="list">
            {r?.rows.map((x) => (
              <div key={x.key} className="day" role="listitem" title={`${x.key}: ${fmtTokens(x.tokens)} tokens · ${x.turns} turns`}>
                <span className="col" style={{ height: `${Math.max(2, (x.tokens / max) * 100)}%` }} />
                <span className="lbl">{x.key.slice(5)}</span>
              </div>
            ))}
          </div>
        ) : (
          <ul className="stats-rows">
            {r?.rows.map((x) => (
              <li
                key={x.key}
                title={`${x.turns} turns${x.cost ? ` · $${x.cost.toFixed(2)}` : ""} — click to filter`}
                role="button"
                tabIndex={0}
                onClick={() => set(by, x.key)}
                onKeyDown={onActivate(() => set(by, x.key))}
              >
                <span className="k">{x.key || "—"}</span>
                <span className="bar">
                  <span style={{ width: `${(x.tokens / max) * 100}%` }} />
                </span>
                <span className="v">{fmtTokens(x.tokens)}</span>
                <span className="p">{(x.share * 100).toFixed(1)}%</span>
              </li>
            ))}
          </ul>
        )}
        <p className="dim small">
          Kept in hive's home folder for good (usage.db), across every project. Task comes from the agent's role (coder, reviewer, tester, planner…). Same data in a terminal:{" "}
          <code>hive stats --by category --days 30</code>
        </p>
      </div>
    </Modal>
  );
}
