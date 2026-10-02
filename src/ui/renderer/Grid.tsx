/** The pane grid, with draggable column and row dividers (double-click one to reset). */
import { useRef } from "react";
import { rpc } from "./bridge.js";
import { store } from "./store.js";
import { saveLayout } from "./layout.js";

export function Grid({ names, columns, widths, widthsKey = "widths", heights, heightsKey = "heights", minRow, children }: { names: string[]; columns: number; widths?: number[]; widthsKey?: "widths" | "vwidths"; heights?: number[]; heightsKey?: "heights" | "vheights"; minRow: number; children: React.ReactNode }) {
  const cols = Math.max(1, Math.min(columns, names.length));
  const w = widths && widths.length === cols ? widths : Array(cols).fill(1);
  const rows = Math.ceil(names.length / cols);
  const h = heights && heights.length === rows ? heights : Array(rows).fill(1);
  const ref = useRef<HTMLDivElement>(null);
  const totalW = w.reduce((a, b) => a + b, 0);
  const totalH = h.reduce((a, b) => a + b, 0);
  // Drag the line between track i and i+1 (columns: x / widths, rows: y / heights).
  const startDrag = (axis: "x" | "y", i: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    const rect = ref.current!.getBoundingClientRect();
    const start = axis === "x" ? [...w] : [...h];
    const total = axis === "x" ? totalW : totalH;
    const key = axis === "x" ? widthsKey : heightsKey;
    const p0 = axis === "x" ? e.clientX : e.clientY;
    const span = axis === "x" ? rect.width : rect.height;
    const move = (ev: PointerEvent) => {
      const dfr = (((axis === "x" ? ev.clientX : ev.clientY) - p0) / span) * total;
      const next = [...start];
      const min = total * 0.08;
      const a = Math.max(min, start[i] + dfr);
      const b = Math.max(min, start[i] + start[i + 1] - a);
      next[i] = start[i] + start[i + 1] - b;
      next[i + 1] = b;
      store.layout = { ...store.layout, [key]: next };
      store.changed();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      void rpc("saveLayout", store.layout);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  let accW = 0;
  let accH = 0;
  return (
    <div
      className="grid"
      ref={ref}
      style={{ gridTemplateColumns: w.map((x) => `minmax(0, ${x}fr)`).join(" "), gridTemplateRows: h.map((x) => `minmax(${minRow}px, ${x}fr)`).join(" ") }}
    >
      {children}
      {w.slice(0, -1).map((x, i) => {
        accW += x;
        return (
          <div
            key={"c" + i}
            className="col-handle"
            style={{ left: `calc(${(accW / totalW) * 100}% - 4px)` }}
            onPointerDown={startDrag("x", i)}
            onDoubleClick={() => saveLayout({ [widthsKey]: undefined })}
            title="drag to resize · double-click to reset"
          />
        );
      })}
      {h.slice(0, -1).map((x, i) => {
        accH += x;
        return (
          <div
            key={"r" + i}
            className="row-handle"
            style={{ top: `calc(${(accH / totalH) * 100}% - 4px)` }}
            onPointerDown={startDrag("y", i)}
            onDoubleClick={() => saveLayout({ [heightsKey]: undefined })}
            title="drag to resize · double-click to reset"
          />
        );
      })}
    </div>
  );
}
