/**
 * Android pane: see and drive an emulator or a phone (USB / Wi-Fi) through adb
 * (src/hive/android.ts). Click = tap, drag = swipe, typing goes to the focused
 * field. Agents use the same device with hive_android_* tools.
 */
import { useEffect, useRef, useState } from "react";
import type { AndroidState } from "../protocol.js";
import { onEvent, rpc } from "./bridge.js";
import { store } from "./store.js";
import { IconRefresh } from "./Icons.js";
import { mapPoint, useFrames, useWatch } from "./Devices.js";

/** Keys the pane sends as Android key events instead of text. */
const KEYMAP: Record<string, string> = {
  Enter: "enter",
  Backspace: "del",
  Delete: "forward_del",
  Tab: "tab",
  Escape: "back",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Home: "move_home",
  End: "move_end",
  PageUp: "page_up",
  PageDown: "page_down",
};

export function AndroidPane() {
  const [st, setSt] = useState<AndroidState | null>(null);
  const [problem, setProblem] = useState("");
  const [apk, setApk] = useState("");
  const [pkg, setPkg] = useState("");
  const [loading, setLoading] = useState(false);
  const img = useRef<HTMLImageElement>(null);
  const view = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; t: number; cx: number; cy: number } | null>(null);
  const { size, hasFrame } = useFrames("android", img);
  const online = st?.devices.filter((d) => d.state === "device") ?? [];
  const ready = !!st?.adb && online.length > 0;
  useWatch("android", (on) => rpc("deviceWatch", { device: "android", on }));

  const refresh = () => {
    setLoading(true);
    void rpc("androidState", {})
      .then((s) => {
        setSt(s);
        setProblem("");
      })
      .catch((e) => setProblem(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    refresh();
    // a device plugged in or an emulator booting shows up without a click
    const t = setInterval(refresh, 8000);
    const off = onEvent((ev) => {
      if (ev.event === "device_state" && ev.device === "android") setSt((prev) => ({ ...ev.state, avds: ev.state.avds.length ? ev.state.avds : (prev?.avds ?? []) }));
      if (ev.event === "device_problem" && ev.device === "android") setProblem(ev.text);
      if (ev.event === "device_frame" && ev.device === "android") setProblem("");
    });
    return () => {
      clearInterval(t);
      off();
    };
  }, []);

  const run = <T,>(p: Promise<T>, ok?: (v: T) => void) =>
    void p.then((v) => ok?.(v)).catch((e) => store.toast(e.message, "error"));
  const input = (p: Parameters<typeof rpc<"androidInput">>[1]) => run(rpc("androidInput", p));
  const action = (a: "rotate" | "install" | "launch" | "startAvd", value?: string) => run(rpc("androidAction", { action: a, value }), (msg) => store.toast(msg));

  return (
    <div className="dv-pane android-pane">
      <div className="dv-bar">
        <select
          value={st?.selected ?? ""}
          onChange={(e) => run(rpc("androidSelect", { serial: e.target.value || null }), setSt)}
          aria-label="device"
          disabled={!st?.devices.length}
        >
          {!st?.devices.length && <option value="">no devices</option>}
          {st?.devices.map((d) => (
            <option key={d.serial} value={d.serial} disabled={d.state !== "device"}>
              {d.model ?? d.serial}
              {d.state !== "device" ? ` (${d.state})` : ""}
            </option>
          ))}
        </select>
        <button className="ghost" onClick={refresh} disabled={loading} aria-label="refresh devices" title="look for devices again">
          <IconRefresh size={14} />
        </button>
        <span className="spacer" />
        <button className="ghost" disabled={!ready} onClick={() => input({ type: "key", key: "back" })} title="Back">
          Back
        </button>
        <button className="ghost" disabled={!ready} onClick={() => input({ type: "key", key: "home" })} title="Home">
          Home
        </button>
        <button className="ghost" disabled={!ready} onClick={() => input({ type: "key", key: "recents" })} title="Recent apps">
          Recents
        </button>
        <button className="ghost" disabled={!ready} onClick={() => action("rotate")} title="rotate the screen 90°">
          Rotate
        </button>
      </div>
      {ready && (
        <div className="dv-sub">
          <input value={apk} onChange={(e) => setApk(e.target.value)} placeholder="path/to/app.apk" aria-label="APK path" spellCheck={false} />
          <button className="ghost" disabled={!apk.trim()} onClick={() => action("install", apk.trim())}>
            Install
          </button>
          <input value={pkg} onChange={(e) => setPkg(e.target.value)} placeholder="com.example.app" aria-label="package to launch" spellCheck={false} />
          <button className="ghost" disabled={!pkg.trim()} onClick={() => action("launch", pkg.trim())}>
            Launch
          </button>
        </div>
      )}
      <div
        ref={view}
        className={`dv-view phone${hasFrame && ready ? "" : " empty"}`}
        tabIndex={0}
        aria-label="Android screen (click to tap, drag to swipe, type to send text)"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (!ready || e.ctrlKey || e.metaKey || e.altKey) return;
          const k = KEYMAP[e.key];
          if (k) {
            e.preventDefault();
            input({ type: "key", key: k });
          } else if (e.key.length === 1) {
            e.preventDefault();
            input({ type: "text", text: e.key });
          }
        }}
        onPaste={(e) => {
          const t = e.clipboardData.getData("text");
          if (t && ready) input({ type: "text", text: t });
        }}
      >
        <img
          ref={img}
          alt=""
          draggable={false}
          style={{ visibility: hasFrame && ready ? "visible" : "hidden" }}
          onPointerDown={(e) => {
            view.current?.focus();
            const p = img.current && mapPoint(e, img.current, size.current);
            if (p) drag.current = { x: p.x, y: p.y, t: Date.now(), cx: e.clientX, cy: e.clientY };
            e.preventDefault();
          }}
          onPointerUp={(e) => {
            const s = drag.current;
            drag.current = null;
            if (!s || !img.current) return;
            const p = mapPoint(e, img.current, size.current);
            const moved = Math.hypot(e.clientX - s.cx, e.clientY - s.cy);
            if (!p || moved < 8) input({ type: "tap", x: s.x, y: s.y });
            else input({ type: "swipe", x1: s.x, y1: s.y, x2: p.x, y2: p.y, ms: Math.max(100, Math.min(2000, Date.now() - s.t)) });
          }}
        />
        {!(hasFrame && ready) && (
          <div className="dv-empty">
            {!st ? (
              <p>Looking for adb…</p>
            ) : !st.adb ? (
              <>
                <p>{st.help}</p>
                <p className="dim">Then press refresh. Guide: docs/DEVICES.md</p>
              </>
            ) : !online.length ? (
              <>
                <p>
                  {st.devices.some((d) => d.state === "unauthorized")
                    ? 'A phone is connected but not authorized: unlock it and tap "Allow USB debugging".'
                    : "No device connected. Start an emulator, or plug in a phone with USB debugging on."}
                </p>
                {st.avds.length > 0 && (
                  <div className="dv-avds">
                    {st.avds.map((a) => (
                      <button key={a} onClick={() => action("startAvd", a)}>
                        Start {a}
                      </button>
                    ))}
                  </div>
                )}
                {st.error && <p className="dim">{st.error}</p>}
              </>
            ) : (
              <p>Waiting for the first screenshot…</p>
            )}
          </div>
        )}
      </div>
      {problem && <div className="dv-problem">{problem}</div>}
    </div>
  );
}
