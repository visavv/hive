/**
 * The device dock: a panel on the right that holds the Browser pane and the
 * Android pane (one visible at a time, tabs when both are open). Opened from
 * the palette, or by itself when an agent starts using a device. Only the
 * visible pane watches its device, so hidden panes cost no frames.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { DeviceFrame, DeviceKind } from "../protocol.js";
import { onEvent } from "./bridge.js";
import { store } from "./store.js";
import { IconClose } from "./Icons.js";
import { BrowserPane } from "./BrowserPane.js";
import { AndroidPane } from "./AndroidPane.js";

const LABEL: Record<DeviceKind, string> = { browser: "Browser", android: "Android" };
const REOPEN_AFTER_CLOSE_MS = 2 * 60_000;

const dock = {
  open: [] as DeviceKind[],
  active: null as DeviceKind | null,
  closedAt: { browser: 0, android: 0 } as Record<DeviceKind, number>,
  subs: new Set<() => void>(),
  version: 0,
  changed() {
    this.version++;
    for (const s of this.subs) s();
  },
};

export function openDevice(d: DeviceKind) {
  if (!dock.open.includes(d)) dock.open = [...dock.open, d];
  dock.active = d;
  dock.changed();
}

export function closeDevice(d: DeviceKind) {
  dock.open = dock.open.filter((x) => x !== d);
  dock.closedAt[d] = Date.now();
  if (dock.active === d) dock.active = dock.open[0] ?? null;
  dock.changed();
}

function useDock() {
  useSyncExternalStore(
    (f) => {
      dock.subs.add(f);
      return () => dock.subs.delete(f);
    },
    () => dock.version,
  );
  return dock;
}

/** Latest frame of a device, drawn straight into an <img> (no React render per frame). */
export function useFrames(device: DeviceKind, img: React.RefObject<HTMLImageElement>) {
  const size = useRef<{ w: number; h: number } | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  useEffect(() => {
    const off = onEvent((ev) => {
        if (ev.event !== "device_frame" || ev.device !== device || !img.current) return;
        const f: DeviceFrame = ev.frame;
        img.current.src = `data:${f.mime};base64,${f.data}`;
        size.current = { w: f.w, h: f.h };
        setHasFrame(true);
    });
    return () => void off();
  }, [device]);
  return { size, hasFrame };
}

/** Watch a device while the pane is shown and the window is visible. */
export function useWatch(device: DeviceKind, rpcWatch: (on: boolean) => Promise<unknown>) {
  useEffect(() => {
    let on = false;
    const set = (v: boolean) => {
      if (v === on) return;
      on = v;
      void rpcWatch(v).catch(() => {});
    };
    const vis = () => set(document.visibilityState === "visible");
    vis();
    document.addEventListener("visibilitychange", vis);
    return () => {
      document.removeEventListener("visibilitychange", vis);
      set(false);
    };
  }, [device]);
}

/**
 * Map a pointer position on an object-fit: contain image to device
 * coordinates (page CSS pixels / screen pixels). Undefined outside the picture.
 */
export function mapPoint(e: { clientX: number; clientY: number }, el: HTMLElement, size: { w: number; h: number } | null) {
  if (!size) return undefined;
  const r = el.getBoundingClientRect();
  const scale = Math.min(r.width / size.w, r.height / size.h);
  if (!scale) return undefined;
  const ox = (r.width - size.w * scale) / 2;
  const oy = (r.height - size.h * scale) / 2;
  const x = (e.clientX - r.left - ox) / scale;
  const y = (e.clientY - r.top - oy) / scale;
  if (x < 0 || y < 0 || x > size.w || y > size.h) return undefined;
  return { x: Math.round(x), y: Math.round(y), scale };
}

export function DeviceDock() {
  const d = useDock();
  const [width, setWidth] = useState(() => {
    try {
      return Number(localStorage.getItem("hive.dockWidth")) || 560;
    } catch {
      return 560;
    }
  });
  // An agent started browsing / using the phone: show it (unless you just closed that pane).
  useEffect(() => {
    const off = onEvent((ev) => {
        if (ev.event !== "device_activity") return;
        if (dock.open.includes(ev.device)) return;
        if (Date.now() - dock.closedAt[ev.device] < REOPEN_AFTER_CLOSE_MS) return;
        openDevice(ev.device);
        store.toast(`${ev.agent} is using the ${ev.device === "browser" ? "sandboxed browser" : "Android device"}`);
    });
    return () => void off();
  }, []);
  if (!d.open.length || !d.active) return null;
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = width;
    let w = w0;
    const move = (ev: PointerEvent) => {
      w = Math.max(320, Math.min(window.innerWidth - 120, w0 + (x0 - ev.clientX)));
      setWidth(w);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try {
        localStorage.setItem("hive.dockWidth", String(Math.round(w)));
      } catch {}
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <aside className="device-dock" style={{ width }} aria-label="device panes">
      <div className="dv-resize" onPointerDown={startResize} title="drag to resize" />
      <div className="dv-tabs" role="tablist">
        {d.open.map((k) => (
          <span key={k} className={`dv-tab${k === d.active ? " on" : ""}`}>
            <button
              className="ghost"
              role="tab"
              aria-selected={k === d.active}
              onClick={() => {
                dock.active = k;
                dock.changed();
              }}
            >
              {LABEL[k]}
            </button>
            <button className="ghost dv-x" onClick={() => closeDevice(k)} aria-label={`close ${LABEL[k]} pane`} title={`close the ${LABEL[k]} pane (the device keeps running)`}>
              <IconClose size={12} />
            </button>
          </span>
        ))}
      </div>
      {d.active === "browser" ? <BrowserPane key="browser" /> : <AndroidPane key="android" />}
    </aside>
  );
}
