/**
 * One agent-state model for the whole UI (herdr's four states with T3's
 * priority order): needs you > error > working > done (finished, not looked
 * at yet) > idle (finished, seen) > starting / stopped.
 */
import { store } from "./store.js";

export type AgentState = "needs" | "error" | "working" | "done" | "idle" | "starting" | "stopped";

export const STATE_LABEL: Record<AgentState, string> = {
  needs: "needs you",
  error: "error",
  working: "working",
  done: "done",
  idle: "idle",
  starting: "starting",
  stopped: "stopped",
};

const PRIORITY: AgentState[] = ["needs", "error", "working", "done", "idle", "starting", "stopped"];

export function agentState(name: string): AgentState {
  const a = store.agents.get(name);
  const st = store.starting.get(name);
  // "needs you" only when there is something to answer in the pane: a tool-set "waiting" status is a note, not a state
  if (store.waitingOn(name) > 0) return "needs";
  if (a?.status === "error" || st?.error) return "error";
  if (!a || a.status === "asleep") return st ? "starting" : "stopped";
  if (a.status === "working" || a.status === "waiting") return "working";
  if (a.status === "starting") return "starting";
  if (store.readyAt.has(name)) return "done";
  return "idle";
}

/** The most urgent state among several agents (for groups and the window title). */
export function rollup(states: AgentState[]): AgentState | undefined {
  for (const s of PRIORITY) if (states.includes(s)) return s;
  return undefined;
}

/** The one state for a raw backend status (agents without a pane, e.g. started by a job or another process). */
export function stateOfStatus(status: string): AgentState {
  return status === "waiting" || status === "working" ? "working" : status === "error" ? "error" : status === "asleep" ? "stopped" : status === "starting" ? "starting" : "idle";
}

export function StatePill({ state, compact }: { state: AgentState; compact?: boolean }) {
  return (
    <span className={`st st-${state}`} role="status" aria-label={STATE_LABEL[state]}>
      <span className="st-dot" />
      {!compact && <span className="st-label">{STATE_LABEL[state]}</span>}
    </span>
  );
}
