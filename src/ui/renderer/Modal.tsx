/** The one dialog frame every modal uses: Esc closes the top one, focus stays inside and goes back on close. */
import { useEffect, useRef } from "react";
import { useOverlay } from "./focus.js";

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const isTop = useOverlay("modal", onClose);
  // Keep keyboard focus inside the dialog, and give it back to where it was on close.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) (el.querySelector<HTMLElement>("[autofocus], input, select, textarea, button") ?? el).focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !el || !isTop()) return;
      const items = [...el.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !(x as HTMLButtonElement).disabled && x.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || !el.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !el.contains(document.activeElement))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", trap, true);
    return () => {
      window.removeEventListener("keydown", trap, true);
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} tabIndex={-1} className={`modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}
