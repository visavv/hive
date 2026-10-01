/** Recipes (ready-made teams) and Skills (reusable prompts with parameters). */
import { useEffect, useRef, useState } from "react";
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

export function SkillsDialog({ onClose, initial }: { onClose: () => void; initial?: { name: string; vals: Record<string, string> } | null }) {
  const [list, setList] = useState<SkillList>([]);
  const [name, setName] = useState("");
  const [vals, setVals] = useState<Record<string, string>>({});
  const [kind, setKind] = useState("");
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState("");
  const prefill = useRef(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void rpc("skills", {}).then((l) => {
      setList(l);
      const want = prefill.current?.name;
      setName(want && l.some((x) => x.name === want) ? want : (l[0]?.name ?? ""));
    });
  }, []);
  const sk = list.find((x) => x.name === name);
  useEffect(() => {
    // Opened with values (e.g. from the prompt editor): keep them for that skill once.
    if (prefill.current && prefill.current.name === name) {
      setVals(prefill.current.vals);
      prefill.current = null;
    } else setVals({});
    setErr("");
    setKind(sk?.agent ?? "claude");
  }, [name, list.length]);
  const run = async () => {
    if (!sk || busy) return;
    setBusy(true);
    setErr("");
    try {
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(vals)) if (v.trim()) params[k] = v;
      const r = await rpc("runSkill", { name: sk.name, params, kind });
      await openPane({ name: r.agent, kind: r.kind, cwd: store.cwd, role: `skill: ${sk.name}`, policy: r.policy });
      setTimeout(() => focus.to(r.agent), 300);
      onClose();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
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
              <button type="submit" className="primary" disabled={busy}>
                {busy ? (Object.values(vals).some((v) => /youtu\.?be/.test(v)) ? "Fetching captions…" : "Starting…") : "Run"}
              </button>
            </div>
          </form>
        )}
      </div>
      <p className="dim small">New skill: <code>hive skill new my-skill --describe "what it should do"</code> — or copy a file in the skills folder.</p>
    </Modal>
  );
}

/**
 * Big editor for long prompts: write comfortably, then send it, turn it into a
 * reusable skill, or have the prompt-engineer skill rewrite it (pick the model there).
 */
export function PromptEditor({ agent, initial, onClose, onSend }: { agent: string; initial: string; onClose: (draft: string) => void; onSend: (text: string) => void }) {
  const [text, setText] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [skillName, setSkillName] = useState("");
  const [desc, setDesc] = useState("");
  const [err, setErr] = useState("");
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const placeholders = [...new Set([...text.matchAll(/\{\{(\w[\w-]*)\}\}/g)].map((m) => m[1]))];
  const send = () => {
    if (!text.trim()) return;
    onSend(text.trim());
  };
  const save = async () => {
    try {
      const r = await rpc("saveSkill", { name: skillName.trim(), description: desc.trim(), body: text });
      store.toast(`skill ${skillName} saved (${r.path})${placeholders.length ? ` with parameters ${placeholders.join(", ")}` : ""}`);
      setSaving(false);
    } catch (e: any) {
      setErr(e.message);
    }
  };
  return (
    <Modal title={`Prompt for ${agent}`} onClose={() => onClose(text)} wide>
      <textarea
        className="prompt-editor"
        value={text}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            send();
          }
        }}
        placeholder="Write or paste a long prompt. Use {{name}} for parts you want to fill in each time if you save it as a skill."
        aria-label="prompt"
      />
      <div className="row1 small dim">
        <span>
          {words.toLocaleString()} words · {text.length.toLocaleString()} chars
        </span>
        {placeholders.length > 0 && <span>· parameters: {placeholders.join(", ")}</span>}
      </div>
      {saving && (
        <form
          className="form save-skill"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label>
            <span>Skill name</span>
            <input value={skillName} onChange={(e) => setSkillName(e.target.value)} placeholder="e.g. app-audit" autoFocus />
          </label>
          <label>
            <span>Description</span>
            <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="one line: what it does" />
          </label>
          {err && <div className="err">{err}</div>}
          <div className="buttons">
            <button type="button" className="ghost" onClick={() => setSaving(false)}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={!/^[\w.-]{1,60}$/.test(skillName.trim())}>
              Save skill
            </button>
          </div>
        </form>
      )}
      <div className="buttons">
        <button
          type="button"
          className="ghost"
          disabled={!text.trim()}
          title="rewrite this into a stronger prompt with the prompt-engineer skill (you pick the model)"
          onClick={() => {
            onClose(text);
            store.requestSkill("prompt-engineer", { goal: text });
          }}
        >
          ✦ Improve with prompt-engineer
        </button>
        <button
          type="button"
          className="ghost"
          disabled={!text.trim()}
          title="send this prompt to several agents at once; a judge compares and picks the best parts"
          onClick={() => {
            onClose(text);
            store.openVerdict({ prompt: text });
          }}
        >
          ⚖ Verdict…
        </button>
        <button type="button" className="ghost" disabled={!text.trim()} onClick={() => setSaving(true)} title="reuse this prompt later from Skills (Ctrl+K)">
          Save as skill…
        </button>
        <span className="spacer" />
        <button type="button" className="ghost" onClick={() => onClose(text)}>
          Keep as draft
        </button>
        <button type="button" className="primary" disabled={!text.trim()} onClick={send} title="Ctrl+Enter">
          Send to {agent}
        </button>
      </div>
    </Modal>
  );
}
