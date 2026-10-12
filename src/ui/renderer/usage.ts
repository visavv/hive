/** One shared poller for the usage summary (the top-bar chip and the Usage tab both read it). */
import { rpc } from "./bridge.js";

export type UsageSummary = Awaited<ReturnType<typeof rpc<"usage">>>;

let latest: UsageSummary | null = null;
const subs = new Set<(u: UsageSummary) => void>();
let timer: ReturnType<typeof setInterval> | undefined;

async function load() {
  try {
    latest = await rpc("usage", {});
    for (const fn of subs) fn(latest);
  } catch {
    /* the backend is restarting; the next tick tries again */
  }
}

/** Subscribe to the usage summary; polls every 10 s while anyone listens. Returns an unsubscribe. */
export function watchUsage(fn: (u: UsageSummary) => void): () => void {
  subs.add(fn);
  if (latest) fn(latest);
  if (!timer) {
    void load();
    timer = setInterval(load, 10_000);
  }
  return () => {
    subs.delete(fn);
    if (!subs.size && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** Re-read now (after saving a budget or pausing). */
export const refreshUsage = load;
