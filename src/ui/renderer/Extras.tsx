/** Recipes (ready-made teams) and Skills (reusable prompts with parameters). */
import { useEffect, useState } from "react";
import { rpc } from "./bridge.js";
import { store, useStore } from "./store.js";
import { Modal, openPane } from "./App.js";
import { focus } from "./focus.js";

type RecipeList = Awaited<ReturnType<typeof rpc<"recipes">>>;
type SkillList = Awaited<ReturnType<typeof rpc<"skills">>>;

function KindSelect({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const kinds = useStore((s) => s.kinds);
  return (
    <label>
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {kinds.map((k) => (
          <option key={k.id} value={k.id}>
            {k.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function RecipesDialog({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<RecipeList>([]);
  const [id, setId] = useState("review-loop");
  const [kind, setKind] = useState("claude");
  const [alt, setAlt] = useState("codex");
  const [prefix, setPrefix] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    void rpc("recipes", {}).then(setList);
  }, []);
  const r = list.find((x) => x.id === id);
  const apply = async () => {
    try {
      const res = await rpc("applyRecipe", { id, kind, alt, prefix: prefix.trim() || undefined });
      for (const a of res.agents.filter((x) => x.interactive))
        void openPane({ name: a.name, kind: a.kind, cwd: store.cwd, role: a.role, policy: a.policy as any, preset: a.preset, worktree: a.worktree });
      store.toast(`${r?.label}: ${res.agents.length} agents${res.jobs.length ? `, ${res.jobs.length} automatic jobs` : ""}${res.groups.length ? `, group ${res.groups.map((g) => "@" + g).join(" ")}` : ""}`);
      onClose();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  return (
    <Modal title="Recipes — a ready-made team" onClose={onClose}>
      <div className="recipe-list">
        {list.map((x) => (
          <button key={x.id} className={`recipe${x.id === id ? " on" : ""}`} onClick={() => setId(x.id)}>
            <strong>{x.label}</strong>
            <span className="dim small">{x.description}</span>
          </button>
        ))}
      </div>
      {r && (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            void apply();
          }}
        >
          <KindSelect label="Main agent" value={kind} onChange={setKind} />
          {r.agents.some((a) => a.alt) && <KindSelect label="Checkers" value={alt} onChange={setAlt} />}
          <label>
            <span>Prefix</span>
            <input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="optional, e.g. yt- for a second copy" />
          </label>
          <p className="dim small">
            Agents: {r.agents.map((a) => `${prefix}${a.name}${a.interactive ? " (you talk to it)" : ""}`).join(", ")}. {r.next}
          </p>
          {err && <div className="err">{err}</div>}
          <div className="buttons">
            <button type="button" className="ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="primary">
              Set up
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

export function SkillsDialog({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<SkillList>([]);
  const [name, setName] = useState("");
  const [vals, setVals] = useState<Record<string, string>>({});
  const [kind, setKind] = useState("");
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState("");
  useEffect(() => {
    void rpc("skills", {}).then((l) => {
      setList(l);
      if (l[0]) setName(l[0].name);
    });
  }, []);
  const sk = list.find((x) => x.name === name);
  useEffect(() => {
    setVals({});
    setErr("");
    setKind(sk?.agent ?? "claude");
  }, [name]);
  const run = async () => {
    if (!sk) return;
    try {
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(vals)) if (v.trim()) params[k] = v;
      const r = await rpc("runSkill", { name: sk.name, params, kind });
      await openPane({ name: r.agent, kind: r.kind, cwd: store.cwd, role: `skill: ${sk.name}`, policy: r.policy });
      setTimeout(() => focus.to(r.agent), 300);
      onClose();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const shown = list.filter((x) => !filter || (x.name + x.description).toLowerCase().includes(filter.toLowerCase()));
  return (
    <Modal title="Skills" onClose={onClose}>
      <div className="skills">
        <div className="skill-list">
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter…" autoFocus />
          {shown.map((x) => (
            <button key={x.name} className={`skill${x.name === name ? " on" : ""}`} onClick={() => setName(x.name)} title={x.description}>
              <strong>{x.name}</strong>
              <span className="dim small">{x.description}</span>
            </button>
          ))}
        </div>
        {sk && (
          <form
            className="form skill-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run();
            }}
          >
            <div className="dim small">
              {sk.description} · {sk.source} · {sk.policy}
              {sk.output ? ` · saves to ${sk.output}` : ""}
            </div>
            {sk.params.map((p) => (
              <label key={p.name}>
                <span>
                  {p.name}
                  {p.required ? " *" : ""}
                </span>
                {p.type === "choice" && p.choices ? (
                  <select value={vals[p.name] ?? p.default ?? ""} onChange={(e) => setVals({ ...vals, [p.name]: e.target.value })}>
                    {!p.required && <option value="" />}
                    {p.choices.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                ) : p.type === "file" ? (
                  <span className="file-row">
                    <input value={vals[p.name] ?? ""} onChange={(e) => setVals({ ...vals, [p.name]: e.target.value })} placeholder={p.description ?? "path to a file"} />
                    <button
                      type="button"
                      onClick={() =>
                        void window.hiveBridge.pickFile?.().then((f) => {
                          if (f) setVals((v) => ({ ...v, [p.name]: f }));
                        })
                      }
                    >
                      Browse…
                    </button>
                  </span>
                ) : p.type === "number" ? (
                  <input type="number" value={vals[p.name] ?? ""} placeholder={p.default ?? ""} onChange={(e) => setVals({ ...vals, [p.name]: e.target.value })} />
                ) : (
                  <textarea rows={2} value={vals[p.name] ?? ""} placeholder={p.description ?? p.default ?? ""} onChange={(e) => setVals({ ...vals, [p.name]: e.target.value })} />
                )}
              </label>
            ))}
            <KindSelect label="Agent" value={kind} onChange={setKind} />
            {err && <div className="err">{err}</div>}
            <div className="buttons">
              <span className="dim small spacer">Runs in its own pane — keep chatting to refine.</span>
              <button type="button" className="ghost" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="primary">
                Run
              </button>
            </div>
          </form>
        )}
      </div>
      <p className="dim small">New skill: <code>hive skill new my-skill --describe "what it should do"</code> — or copy a file in the skills folder.</p>
    </Modal>
  );
}
