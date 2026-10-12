/** Add agent and Schedule a job: the two dialogs that start work on an agent. */
import { useEffect, useMemo, useState } from "react";
import type { Policy } from "../protocol.js";
import { rpc } from "./bridge.js";
import { store, useStore } from "./store.js";
import { agentNameProblem } from "../../core/names.js";
import { focus } from "./focus.js";
import { parseDuration, suggestName } from "./format.js";
import { Modal } from "./Modal.js";
import { openPane } from "./layout.js";

const POLICIES: Policy[] = ["ask", "allow-reads", "allow-all", "reject-all"];

export function AddAgentDialog({ onClose }: { onClose: () => void }) {
  const kinds = useStore((s) => s.kinds);
  const taken = useMemo(() => new Set(store.layout.panes.map((p) => p.name)), []);
  const [kind, setKind] = useState(kinds.find((k) => k.id === "claude")?.id ?? kinds[0]?.id ?? "");
  const [name, setName] = useState(() => suggestName(taken));
  const [cwd, setCwd] = useState(store.layout.panes.at(-1)?.cwd ?? store.cwd);
  const presets = useStore((s) => s.presets);
  const [presetId, setPresetId] = useState("");
  const [role, setRole] = useState("");
  const [policy, setPolicy] = useState<Policy>("ask");
  const [worktree, setWorktree] = useState(false);
  const [startJob, setStartJob] = useState(true);
  const [err, setErr] = useState("");
  // ---- creator: extra MCP servers from <HIVE_HOME>/mcp.json ----
  const [mcpList, setMcpList] = useState<{ name: string; command: string }[]>([]);
  const [mcp, setMcp] = useState<string[]>([]);
  useEffect(() => {
    rpc("mcpServers", {}).then(setMcpList, () => setMcpList([]));
  }, []);
  // models: what this kind offered before (remembered), else type one; empty = the agent's default
  const [model, setModel] = useState("");
  const [models, setModels] = useState<{ value: string; name: string }[]>([]);
  useEffect(() => {
    setModel("");
    rpc("kindModels", { kind }).then(setModels, () => setModels([]));
  }, [kind]);
  const preset = presets.find((p) => p.id === presetId);
  const pickPreset = (id: string) => {
    setPresetId(id);
    const p = presets.find((x) => x.id === id);
    if (!p) return;
    setRole(p.role);
    setPolicy(p.policy);
    setWorktree(p.worktree);
  };
  const submit = () => {
    const n = name.trim();
    const problem = agentNameProblem(n);
    if (problem) return setErr(`name: ${problem}`);
    if (taken.has(n)) return setErr(`"${n}" is already open`);
    onClose();
    void openPane(
      { name: n, kind, cwd: cwd.trim() || store.cwd, role: role.trim(), policy, worktree, preset: presetId || undefined, ...(mcp.length ? { mcp } : {}), ...(model.trim() ? { model: model.trim() } : {}) },
      true,
      !!preset?.job && startJob,
    );
    setTimeout(() => focus.to(n), 300);
  };
  return (
    <Modal title="Add agent" onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
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
        {(() => {
          const k = kinds.find((x) => x.id === kind);
          if (!k?.missing && !k?.api) return null;
          return (
            <div className={`hint small ${k.missing ? "warn" : "dim"}`}>
              {k.missing ? `${k.missing} is not set. ` : "Billed per token to your API key. "}
              {k.install}
            </div>
          );
        })()}
        <label>
          <span>Model</span>
          {models.length ? (
            <select className="add-model" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">default</option>
              {models.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="field-col">
              <input className="add-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder="default" />
              <span className="hint small dim">or type a model id; the list fills in once this agent has run</span>
            </span>
          )}
        </label>
        <label>
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          <span>Folder</span>
          <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder={store.cwd} />
        </label>
        <label>
          <span>Preset</span>
          <select value={presetId} onChange={(e) => pickPreset(e.target.value)}>
            <option value="">— none —</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
                {p.job ? ` · ${p.job}` : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Role</span>
          <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="coder, reviewer, security watcher… (shown to other agents)" />
        </label>
        <label>
          <span>Permissions</span>
          <select value={policy} onChange={(e) => setPolicy(e.target.value as Policy)}>
            {POLICIES.map((p) => (
              <option key={p} value={p}>
                {p}
                {/* the same words the pane's sub row uses: asks first / reads freely / full access / chat only */}
                {p === "ask" ? " — asks first: every edit or command waits for your OK in the pane" : p === "allow-reads" ? " — reads freely: reading and searching allowed, edits and commands ask" : p === "allow-all" ? " — full access: runs anything without asking (give it its own worktree)" : " — chat only: no files, no commands"}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Worktree</span>
          <span className="check">
            <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} />
            own git worktree on branch hive/{name || "<name>"} (recommended for agents that edit)
          </span>
        </label>
        {policy === "allow-all" && !worktree && (
          <div className="hint small warn" role="note">
            Allow all outside a worktree: this agent runs commands as you and can change any file you can, including your checkout and hive's own settings. Prefer
            a worktree, or "ask".
          </div>
        )}
        {mcpList.length > 0 && (
          <div className="creator-mcp">
            <span>MCP</span>
            <div className="creator-mcp-list">
              {mcpList.map((m) => (
                <label key={m.name} className="check" title={m.command}>
                  <input
                    type="checkbox"
                    checked={mcp.includes(m.name)}
                    onChange={(e) => setMcp(e.target.checked ? [...mcp, m.name] : mcp.filter((x) => x !== m.name))}
                  />
                  {m.name}
                </label>
              ))}
            </div>
          </div>
        )}
        {preset?.job && (
          <label>
            <span>Job</span>
            <span className="check">
              <input type="checkbox" checked={startJob} onChange={(e) => setStartJob(e.target.checked)} />
              also start the preset's job ({preset.job})
            </span>
          </label>
        )}
        {err && <div className="err">{err}</div>}
        <div className="buttons">
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary">Add</button>
        </div>
      </form>
    </Modal>
  );
}

export function JobDialog({ agent, onClose }: { agent: string; onClose: () => void }) {
  const [kind, setKind] = useState<"loop" | "interval" | "watch" | "once">("loop");
  const [prompt, setPrompt] = useState("");
  const [times, setTimes] = useState("5");
  const [forS, setForS] = useState("");
  const [every, setEvery] = useState("10m");
  const [path, setPath] = useState(".");
  const [minLines, setMinLines] = useState("50");
  const [maxWait, setMaxWait] = useState("");
  const [cooldown, setCooldown] = useState("");
  const [err, setErr] = useState("");
  const submit = async () => {
    if (!prompt.trim()) return setErr("write the instruction the agent should run");
    const p: Parameters<typeof rpc<"addJob">>[1] = { agent, kind, prompt: prompt.trim() };
    if (kind === "loop") {
      if (times.trim()) p.times = Number(times);
      if (forS.trim()) {
        const ms = parseDuration(forS);
        if (!ms) return setErr(`bad duration "${forS}" (e.g. 8h, 90m)`);
        p.forMs = ms;
      }
      if (!p.times && !p.forMs) return setErr("set times and/or a duration");
    } else if (kind === "interval") {
      const ms = parseDuration(every);
      if (!ms) return setErr(`bad interval "${every}" (e.g. 10m)`);
      p.everyMs = ms;
    } else if (kind === "watch") {
      p.watchPath = path.trim() || ".";
      p.minLines = Number(minLines) || (p.watchPath.startsWith("@bb:") ? 1 : 50);
      if (maxWait.trim()) {
        const ms = parseDuration(maxWait);
        if (!ms) return setErr(`bad duration "${maxWait}" (e.g. 30m)`);
        p.maxWaitMs = ms;
      }
      if (cooldown.trim()) {
        const ms = parseDuration(cooldown);
        if (!ms) return setErr(`bad duration "${cooldown}" (e.g. 10m)`);
        p.cooldownMs = ms;
      }
    }
    try {
      const id = await rpc("addJob", p);
      store.toast(`job #${id} scheduled on ${agent}`);
      onClose();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  return (
    <Modal title={`Schedule a job on ${agent}`} onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="seg">
          {(["loop", "interval", "watch", "once"] as const).map((k) => (
            <button type="button" key={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
              {k === "interval" ? "every" : k}
            </button>
          ))}
        </div>
        <p className="dim small">
          {kind === "loop" && "Runs back to back, each time in a fresh session. A notes file carries findings between runs."}
          {kind === "interval" && "Runs on a timer, each time in a fresh session."}
          {kind === "watch" && "Runs when enough lines change under the folder (untracked files count; .git, node_modules, .hive ignored)."}
          {kind === "once" && "Runs once now in a fresh session."}
          {" "}Each run starts a new conversation on this agent.
        </p>
        <label>
          <span>Instruction</span>
          <textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} autoFocus placeholder="e.g. hunt for bugs in src/ and fix one per run" />
        </label>
        {kind === "loop" && (
          <>
            <label>
              <span>How many runs</span>
              <input value={times} onChange={(e) => setTimes(e.target.value)} placeholder="5" />
            </label>
            <label>
              <span>Or stop after</span>
              <input value={forS} onChange={(e) => setForS(e.target.value)} placeholder="8h (optional)" />
            </label>
          </>
        )}
        {kind === "interval" && (
          <label>
            <span>Every</span>
            <input value={every} onChange={(e) => setEvery(e.target.value)} placeholder="10m" />
          </label>
        )}
        {kind === "watch" && (
          <>
            <label>
              <span>Watch</span>
              <select
                value={path === "@branches" ? "@branches" : path.startsWith("@bb:") ? "@bb" : "path"}
                onChange={(e) => {
                  const v = e.target.value;
                  setPath(v === "@branches" ? "@branches" : v === "@bb" ? "@bb:ideas/raw/" : ".");
                  setMinLines(v === "@bb" ? "1" : "50");
                }}
              >
                <option value="path">a folder (changed lines)</option>
                <option value="@branches">agents' branches (hive/*) — commits by coders in worktrees</option>
                <option value="@bb">blackboard entries (new items under a prefix)</option>
              </select>
            </label>
            {path.startsWith("@bb:") && (
              <label>
                <span>Prefix</span>
                <input value={path.slice(4)} onChange={(e) => setPath("@bb:" + e.target.value)} placeholder="ideas/raw/" />
              </label>
            )}
            {path !== "@branches" && !path.startsWith("@bb:") && (
              <label>
                <span>Path</span>
                <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="relative to the agent's folder" />
              </label>
            )}
            <label>
              <span>{path.startsWith("@bb:") ? "Run after … new entries" : "Run after … changed lines"}</span>
              <input value={minLines} onChange={(e) => setMinLines(e.target.value)} />
            </label>
            <label>
              <span>Or after this long</span>
              <input value={maxWait} onChange={(e) => setMaxWait(e.target.value)} placeholder="e.g. 30m: any change gets looked at after this long" />
            </label>
            <label>
              <span>At most once every</span>
              <input value={cooldown} onChange={(e) => setCooldown(e.target.value)} placeholder="e.g. 10m" />
            </label>
          </>
        )}
        {err && <div className="err">{err}</div>}
        <div className="buttons">
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary">Schedule</button>
        </div>
      </form>
    </Modal>
  );
}
