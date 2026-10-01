/**
 * Browser pane: a live view of hive's sandboxed Chromium (src/hive/browser.ts).
 * The page itself never loads here — the backend streams pictures of it, and
 * clicks, scrolls and keys are sent back. Its profile is separate from your
 * own browser (in memory unless "keep logins" is on), so nothing it opens sees
 * your cookies. Agents drive the same page with hive_browser_* tools.
 */
import { useEffect, useRef, useState } from "react";
import type { BrowserState } from "../protocol.js";
import { onEvent, rpc } from "./bridge.js";
import { store } from "./store.js";
import { IconExpand, IconLock, IconRefresh } from "./Icons.js";
import { mapPoint, useFrames, useWatch } from "./Devices.js";

const MODS = (e: React.KeyboardEvent | React.MouseEvent) =>
  [e.ctrlKey && "Control", e.shiftKey && "Shift", e.altKey && "Alt", e.metaKey && "Meta"].filter(Boolean) as string[];

export function BrowserPane() {
  const [st, setSt] = useState<BrowserState | null>(null);
  const [url, setUrl] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const img = useRef<HTMLImageElement>(null);
  const view = useRef<HTMLDivElement>(null);
  const { size, hasFrame } = useFrames("browser", img);
  const lastMove = useRef(0);
  useWatch("browser", (on) => rpc("deviceWatch", { device: "browser", on }));

  useEffect(() => {
    void rpc("browserState", {}).then(setSt).catch(() => {});
    const off = onEvent((ev) => {
      if (ev.event === "device_state" && ev.device === "browser") setSt(ev.state);
    });
    return () => void off();
  }, []);
  useEffect(() => {
    if (!editing) setUrl(st?.url && st.url !== "about:blank" ? st.url : "");
  }, [st?.url, editing]);

  const act = async <T,>(p: Promise<T>) => {
    setBusy(true);
    try {
      return await p;
    } catch (e: any) {
      store.toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  };
  const go = async () => {
    if (!url.trim()) return;
    setEditing(false);
    const s = await act(rpc("browserOpen", { url }));
    if (s) setSt(s);
    view.current?.focus();
  };
  const nav = (action: "back" | "forward" | "reload") => void act(rpc("browserNav", { action })).then((s) => s && setSt(s));
  const send = (p: Parameters<typeof rpc<"browserInput">>[1]) => void rpc("browserInput", p).catch(() => {});
  const point = (e: React.MouseEvent) => (img.current ? mapPoint(e, img.current, size.current) : undefined);

  return (
    <div className="dv-pane browser-pane">
      <div className="dv-bar">
        <button className="ghost" onClick={() => nav("back")} aria-label="back" title="back" disabled={!st?.running}>
          ←
        </button>
        <button className="ghost" onClick={() => nav("forward")} aria-label="forward" title="forward" disabled={!st?.running}>
          →
        </button>
        <button className="ghost" onClick={() => nav("reload")} aria-label="reload" title="reload" disabled={!st?.running}>
          <IconRefresh size={14} />
        </button>
        <input
          className="dv-url"
          value={url}
          onFocus={(e) => {
            setEditing(true);
            e.currentTarget.select();
          }}
          onBlur={() => setEditing(false)}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void go();
            if (e.key === "Escape") {
              setEditing(false);
              e.currentTarget.blur();
            }
          }}
          placeholder="Enter a URL, e.g. localhost:3000"
          aria-label="address"
          spellCheck={false}
        />
        <button className="ghost" onClick={() => void go()} disabled={busy || !url.trim()}>
          Go
        </button>
        <button
          className="ghost"
          onClick={() => st?.url && /^https?:/.test(st.url) && window.open(st.url, "_blank")}
          disabled={!st?.url || !/^https?:/.test(st.url)}
          title="open this page in your own browser (with your own logins)"
          aria-label="open in your own browser"
        >
          <IconExpand size={14} />
        </button>
      </div>
      <div className="dv-sub">
        <span className="dv-badge" title="A separate Chromium run by hive: its own profile, never your browser's cookies or logins. Pages are shown as pictures.">
          <IconLock size={12} /> sandboxed · separate profile
        </span>
        <label className="dv-check" title="Keep cookies and logins for this project in hive's own profile folder (still separate from your browser). Off: everything is forgotten when the browser closes.">
          <input type="checkbox" checked={!!st?.persistent} onChange={(e) => void act(rpc("browserSettings", { persistent: e.target.checked })).then((s) => s && setSt(s))} />
          keep logins for this project
        </label>
        <span className="spacer" />
        {st?.title && <span className="dv-title" title={st.title}>{st.title}</span>}
      </div>
      <div
        ref={view}
        className={`dv-view${hasFrame && st?.running ? "" : " empty"}`}
        tabIndex={0}
        aria-label="browser page (click to interact, type to send keys)"
        onKeyDown={(e) => {
          // The page gets the keys, not hive's shortcuts (Ctrl+V pastes via onPaste).
          e.stopPropagation();
          if (!st?.running) return;
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") return;
          e.preventDefault();
          send({ type: "key", key: e.key, mods: MODS(e) });
        }}
        onPaste={(e) => {
          const t = e.clipboardData.getData("text");
          if (t && st?.running) send({ type: "text", text: t });
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <img
          ref={img}
          alt=""
          draggable={false}
          style={{ visibility: hasFrame && st?.running ? "visible" : "hidden" }}
          onMouseDown={(e) => {
            view.current?.focus();
            const p = point(e);
            if (p) send({ type: "down", x: p.x, y: p.y, button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left" });
            e.preventDefault();
          }}
          onMouseUp={(e) => {
            const p = point(e);
            if (p) send({ type: "up", x: p.x, y: p.y, button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left" });
          }}
          onMouseMove={(e) => {
            const now = Date.now();
            if (now - lastMove.current < 50) return;
            lastMove.current = now;
            const p = point(e);
            if (p) send({ type: "move", x: p.x, y: p.y });
          }}
          onWheel={(e) => {
            const p = point(e);
            if (p) send({ type: "wheel", x: p.x, y: p.y, dx: e.deltaX, dy: e.deltaY });
          }}
        />
        {!(hasFrame && st?.running) && (
          <div className="dv-empty">
            {st && !st.available ? (
              <p>{st.help}</p>
            ) : st?.error ? (
              <p>Chromium did not start: {st.error}</p>
            ) : (
              <>
                <p>Type an address above to open a page in hive's own browser.</p>
                <p className="dim">It never sees your browser's logins. Agents can use it too, to test the web app they're building.</p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
