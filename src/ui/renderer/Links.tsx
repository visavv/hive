/**
 * Linking agents: drag one pane onto another (or use 🔗) to put them in a
 * group so they can talk; open a group to see its conversation, post to it,
 * and act as the layer in between (review mode: each agent message waits
 * for you to release, edit or drop it; or an hourly cap).
 */
import { useEffect, useState } from "react";
import type { GroupView, MailView } from "../protocol.js";
import { rpc } from "./bridge.js";
import { store, useStore } from "./store.js";
import { Modal } from "./App.js";
import { fmtIdle } from "./format.js";

/** Pause icon drawn in SVG (the ⏸ glyph is missing from common Linux fonts). */
export function PauseIcon({ title }: { title?: string }) {
  return (
    <svg className="ico" width="9" height="10" viewBox="0 0 9 10" role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <rect x="1" y="1" width="2.5" height="8" rx="0.5" fill="currentColor" />
      <rect x="5.5" y="1" width="2.5" height="8" rx="0.5" fill="currentColor" />
    </svg>
  );
}

/** Stable color per group name (also used for the pane stripe). */
export function groupColor(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 65% 62%)`;
}

export function GroupChips({ agent }: { agent: string }) {
  const groups = useStore((s) => s.groups.filter((g) => g.members.includes(agent)));
  if (!groups.length) return null;
  return (
    <span className="group-chips">
      {groups.map((g) => (
        <button
          key={g.name}
          className="group-chip"
          style={{ ["--grp" as any]: groupColor(g.name) }}
          onClick={(e) => {
            e.stopPropagation();
            store.openGroup(g.name);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          title={`@${g.name}: ${g.members.join(", ")} · ${g.mode === "review" ? "you review each message" : "direct"}${g.maxPerHour ? ` · max ${g.maxPerHour}/h` : ""} — open the group chat`}
        >
          <span className="gname">@{g.name}</span>
          {g.mode === "review" && <PauseIcon title="you review each message" />}
          {g.held > 0 && <span className="badge alert">{g.held}</span>}
        </button>
      ))}
    </span>
  );
}

export function LinkDialog({ members: initial, onClose }: { members: string[]; onClose: () => void }) {
  const groups = useStore((s) => s.groups);
  const names = useStore((s) => [...new Set([...s.layout.panes.map((p) => p.name), ...s.others.map((o) => o.name)])]);
  const scope = useStore((s) => s.mailScope);
  const [members, setMembers] = useState(initial.filter(Boolean));
  const candidates = groups.filter((g) => members.some((m) => g.members.includes(m)));
  const [target, setTarget] = useState<string>(""); // "" = new group
  const [typedName, setTypedName] = useState<string | null>(null);
  // The default name follows the members until you type your own.
  const name = typedName ?? members.join("-").slice(0, 40);
  const setName = (v: string) => setTypedName(v);
  const [mode, setMode] = useState<"direct" | "review">("direct");
  const [cap, setCap] = useState("");
  const [me, setMe] = useState(true);
  const [err, setErr] = useState("");
  const submit = async () => {
    try {
      const g = await rpc("link", {
        members,
        name: target || name,
        ...(target ? {} : { mode, maxPerHour: cap.trim() ? Number(cap) : null }),
        includeOwner: me,
      });
      store.toast(`linked @${g.name}: ${g.members.join(", ")}${g.mode === "review" ? " (you review each message)" : ""}`);
      onClose();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  return (
    <Modal title="Link agents so they can talk" onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label>
          <span>Agents</span>
          <span className="link-members">
            {members.map((m) => (
              <span key={m} className="chip">
                {m}
                {members.length > 2 && (
                  <button type="button" className="ghost small" onClick={() => setMembers(members.filter((x) => x !== m))} aria-label={`remove ${m}`}>
                    ✕
                  </button>
                )}
              </span>
            ))}
            <select value="" onChange={(e) => e.target.value && setMembers([...members, e.target.value])} aria-label="add an agent">
              <option value="">+ agent</option>
              {names
                .filter((n) => !members.includes(n))
                .map((n) => (
                  <option key={n}>{n}</option>
                ))}
            </select>
          </span>
        </label>
        <label>
          <span>Group</span>
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">new group…</option>
            {candidates.map((g) => (
              <option key={g.name} value={g.name}>
                add to @{g.name} ({g.members.join(", ")})
              </option>
            ))}
          </select>
        </label>
        {!target && (
          <>
            <label>
              <span>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. dev" />
            </label>
            <fieldset className="modes">
              <legend>Between them</legend>
              <label className="radio">
                <input type="radio" checked={mode === "direct"} onChange={() => setMode("direct")} /> Direct: they message each other freely
              </label>
              <label className="radio">
                <input type="radio" checked={mode === "review"} onChange={() => setMode("review")} /> Review: each message waits for you (release, edit or drop)
              </label>
              <label>
                <span>Max per hour</span>
                <input type="number" min={1} value={cap} onChange={(e) => setCap(e.target.value)} placeholder="no cap (extra messages wait for you)" />
              </label>
            </fieldset>
          </>
        )}
        <label className="radio">
          <input type="checkbox" checked={me} onChange={(e) => setMe(e.target.checked)} /> include me (I get the group's messages in my inbox)
        </label>
        {scope === "open" && (
          <p className="dim small">
            Agents can currently message anyone. To keep them working alone until you link them, switch the sidebar's Groups section to "only linked".
          </p>
        )}
        {err && <div className="err">{err}</div>}
        <div className="buttons">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={members.length < 2}>
            Link
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function GroupChat({ name, onClose }: { name: string; onClose: () => void }) {
  const [data, setData] = useState<{ group: GroupView; messages: MailView[] } | null>(null);
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<{ id: number; body: string } | null>(null);
  const names = useStore((s) => [...new Set([...s.layout.panes.map((p) => p.name), ...s.others.map((o) => o.name)])]);
  const load = () =>
    void rpc("groupChat", { name })
      .then(setData)
      .catch((e) => {
        store.toast(e.message, "error");
        onClose();
      });
  useEffect(() => {
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [name]);
  const act = (p: Promise<unknown>) => void p.then(load).catch((e) => store.toast(e.message, "error"));
  const g = data?.group;
  const post = () => {
    const t = text.trim();
    if (!t) return;
    act(rpc("sendMail", { to: "@" + name, body: t }).then(() => setText("")));
  };
  return (
    <Modal title={`@${name}`} onClose={onClose} wide>
      {g && (
        <div className="group-head" style={{ ["--grp" as any]: groupColor(name) }}>
          <span className="link-members">
            {g.members.map((m) => (
              <span key={m} className="chip">
                {m}
                <button type="button" className="ghost small" onClick={() => act(rpc("setGroup", { name, remove: m }))} aria-label={`remove ${m} from the group`} title="remove from group">
                  ✕
                </button>
              </span>
            ))}
            <select value="" onChange={(e) => e.target.value && act(rpc("setGroup", { name, add: e.target.value }))} aria-label="add a member">
              <option value="">+ member</option>
              {[...names, "owner"]
                .filter((n) => !g.members.includes(n))
                .map((n) => (
                  <option key={n}>{n}</option>
                ))}
            </select>
          </span>
          <span className="spacer" />
          <div className="seg" role="group" aria-label="mode">
            <button className={g.mode === "direct" ? "on" : ""} onClick={() => act(rpc("setGroup", { name, mode: "direct" }))} title="agents message each other freely">
              Direct
            </button>
            <button className={g.mode === "review" ? "on" : ""} onClick={() => act(rpc("setGroup", { name, mode: "review" }))} title="each agent message waits for you">
              Review each message
            </button>
          </div>
          <label className="cap">
            max/h
            <input
              type="number"
              min={1}
              defaultValue={g.maxPerHour ?? ""}
              key={String(g.maxPerHour)}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (String(g.maxPerHour ?? "") !== v) act(rpc("setGroup", { name, maxPerHour: v ? Number(v) : null }));
              }}
              aria-label="max agent messages per hour"
              placeholder="∞"
            />
          </label>
        </div>
      )}
      <div className="group-log" aria-live="polite">
        {data && !data.messages.length && <div className="dim pad">No messages yet. Post below, or tell an agent to message @{name}.</div>}
        {data?.messages.map((m) => (
          <div key={m.id} className={`gmsg${m.held ? " held" : ""}${m.from_agent === "owner" ? " mine" : ""}`}>
            <div className="row1">
              <strong>{m.from_agent}</strong>
              <span className="dim">→ {m.to_agent}</span>
              <span className="subj">{m.subject}</span>
              <span className="spacer" />
              <span className="dim small">{fmtIdle(Date.now() - m.ts)} ago</span>
            </div>
            {editing?.id === m.id ? (
              <textarea className="prompt-editor small-editor" value={editing.body} onChange={(e) => setEditing({ id: m.id, body: e.target.value })} aria-label="edit message" />
            ) : (
              <div className="mail-body">{m.body}</div>
            )}
            {m.held && (
              <div className="held-bar">
                <span className="warn small">
                  <PauseIcon /> {m.held}
                </span>
                <span className="spacer" />
                {editing?.id === m.id ? (
                  <button className="primary" onClick={() => act(rpc("releaseMail", { id: m.id, body: editing.body }).then(() => setEditing(null)))}>
                    Send edited
                  </button>
                ) : (
                  <>
                    <button className="primary" onClick={() => act(rpc("releaseMail", { id: m.id }))}>
                      Release
                    </button>
                    <button onClick={() => setEditing({ id: m.id, body: m.body })}>Edit…</button>
                  </>
                )}
                <button className="danger" onClick={() => act(rpc("dropMail", { id: m.id }))}>
                  Drop
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="compose">
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && post()} placeholder={`message @${name} as you (never held)`} aria-label="message the group" />
        <button onClick={post} disabled={!text.trim()}>
          Send
        </button>
        <button
          className="ghost danger"
          onClick={() => {
            if (confirm(`Delete @${name}? Members stop sharing this channel.`)) act(rpc("setGroup", { name, delete: true }).then(onClose));
          }}
        >
          Delete group
        </button>
      </div>
    </Modal>
  );
}

/** Sidebar section: groups, waiting messages, and who may message whom. */
export function GroupsSection() {
  const groups = useStore((s) => s.groups);
  const scope = useStore((s) => s.mailScope);
  return (
    <>
      <div className="side-head">
        <span>Groups</span>
        <button className="ghost" onClick={() => store.requestLink([])} title="link agents (or drag one pane onto another)" aria-label="link agents">
          🔗
        </button>
      </div>
      <div className="scope-row">
        <span className="dim small">agents can message</span>
        <div className="seg small" role="group" aria-label="who agents can message">
          <button className={scope === "open" ? "on" : ""} onClick={() => void rpc("setScope", { scope: "open" })} title="any agent can message any agent">
            anyone
          </button>
          <button className={scope === "linked" ? "on" : ""} onClick={() => void rpc("setScope", { scope: "linked" })} title="agents work alone until you link them">
            only linked
          </button>
        </div>
      </div>
      <ul className="agent-list">
        {groups.map((g) => (
          <li key={g.name} className="agent-item group-item" style={{ ["--grp" as any]: groupColor(g.name) }} onClick={() => store.openGroup(g.name)}>
            <div className="row1">
              <span className="gdot" />
              <strong>@{g.name}</strong>
              <span className="spacer" />
              {g.mode === "review" && <span className="badge" title="you review each message">review</span>}
              {g.held > 0 && <span className="badge alert" title="messages waiting for you">{g.held}</span>}
            </div>
            <div className="row3">{g.members.join(", ")}</div>
          </li>
        ))}
        {!groups.length && <li className="dim pad small">Drag a pane's name onto another pane to link them.</li>}
      </ul>
    </>
  );
}
