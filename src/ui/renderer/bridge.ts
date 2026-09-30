/** Renderer side of the protocol: request/response RPC plus an event stream. */
import type { BackendEvent, Methods, MethodName } from "../protocol.js";

interface HiveBridge {
  send(line: string): void;
  onMessage(fn: (line: string) => void): void;
  onFocusLast(fn: () => void): void;
  hello(): Promise<boolean>;
  /** Flash the taskbar entry when the window isn't focused. */
  attention?(): void;
}

declare global {
  interface Window {
    hiveBridge: HiveBridge;
  }
}

let nextId = 1;
const waiting = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
const listeners = new Set<(e: BackendEvent) => void>();

export function connect() {
  const b = window.hiveBridge;
  if (!b) throw new Error("hive bridge missing (not running inside the hive app?)");
  b.onMessage((line) => {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const w = waiting.get(msg.id);
      if (!w) return;
      waiting.delete(msg.id);
      if (msg.error) w.rej(new Error(msg.error));
      else w.res(msg.result);
      return;
    }
    if (msg.event === "backend_down") {
      // Nothing in flight will be answered by the old backend.
      for (const [id, w] of waiting) {
        waiting.delete(id);
        w.rej(new Error("hive backend restarted"));
      }
    }
    for (const l of listeners) l(msg as BackendEvent);
  });
}

/** True if the backend is already up (renderer reload): the caller should fetch state now. */
export function hello(): Promise<boolean> {
  return window.hiveBridge.hello();
}

export function onEvent(fn: (e: BackendEvent) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function rpc<M extends MethodName>(method: M, params: Parameters<Methods[M]>[0]): Promise<ReturnType<Methods[M]>> {
  const id = nextId++;
  return new Promise((res, rej) => {
    waiting.set(id, { res, rej });
    window.hiveBridge.send(JSON.stringify({ id, method, params }));
  });
}

export function onFocusLast(fn: () => void) {
  window.hiveBridge?.onFocusLast(fn);
}
