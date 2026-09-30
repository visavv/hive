/** Renderer side of the protocol: request/response RPC plus an event stream. */
import type { BackendEvent, Methods, MethodName } from "../protocol.js";

interface HiveBridge {
  send(line: string): void;
  onMessage(fn: (line: string) => void): void;
  onFocusLast(fn: () => void): void;
  hello(): Promise<string | null>;
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
    for (const l of listeners) l(msg as BackendEvent);
  });
  // After a renderer reload the backend is still up; replay its ready event.
  void b.hello().then((line) => {
    if (line) for (const l of listeners) l(JSON.parse(line));
  });
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
