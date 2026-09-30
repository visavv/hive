/**
 * Wire types between the UI backend (Node child process that owns the Hub),
 * the Electron main process (a dumb relay) and the renderer.
 *
 *   renderer ⇄ (contextBridge IPC) ⇄ electron main ⇄ (NDJSON on stdio) ⇄ backend
 *
 * The backend runs on system Node rather than inside Electron because
 * better-sqlite3 is built for Node's ABI; this also means no socket is ever
 * opened (design rule: localhost only, no listeners).
 */
import type { SessionEvent } from "../core/session.js";

export type Policy = "ask" | "allow-reads" | "allow-all" | "reject-all";

export interface PaneSpec {
  name: string;
  kind: string;
  cwd: string;
  role?: string;
  policy?: Policy;
  /** Role preset id (roles.ts): adds its briefing. */
  preset?: string;
  /** Run in its own git worktree (.hive/worktrees/<name>). */
  worktree?: boolean;
}

export interface PresetView {
  id: string;
  label: string;
  role: string;
  policy: Policy;
  worktree: boolean;
  job?: string;
}

export interface WorktreeView {
  name: string;
  branch: string;
  ahead: number;
  behind: number;
  files: number;
  insertions: number;
  deletions: number;
  dirty: number;
}

export interface Layout {
  panes: PaneSpec[];
  columns: number;
  /** Relative column widths (fr units), length = columns. */
  widths?: number[];
  hoverFocus: boolean;
  sidebar: boolean;
  /** Pane name shown alone, if any. */
  maximized?: string | null;
}

export interface ConfigOptionView {
  id: string;
  name: string;
  category?: string | null;
  type: string;
  currentValue: string | boolean;
  options?: { value: string; name: string }[];
}

export interface AgentView {
  name: string;
  kind: string;
  label: string;
  cwd: string;
  role: string;
  policy: Policy;
  status: "idle" | "working" | "waiting" | "error" | "asleep" | "starting";
  note: string;
  idleMs: number;
  queued: number;
  unread: number;
  sessionId?: string;
  ctx?: { used: number; size: number };
  config: ConfigOptionView[];
  auth?: string;
  jobs: number;
}

export interface JobView {
  id: number;
  kind: string;
  agent: string;
  agentKind: string;
  prompt: string;
  schedule: string;
  runs: number;
  state: string;
  lastError?: string | null;
  nextRun?: number;
}

export interface PermissionAsk {
  reqId: string;
  agent: string;
  title: string;
  kind?: string;
  options: { optionId: string; name: string; kind: string }[];
  /** diff / command preview when the agent sent tool content. */
  detail?: string;
}

export interface ElicitationAsk {
  reqId: string;
  agent: string;
  message: string;
  mode: string;
  url?: string;
  fields: { key: string; title: string; type: string; description?: string; choices?: string[]; required: boolean }[];
}

/** Backend → UI */
export type BackendEvent =
  | { event: "ready"; kinds: { id: string; label: string }[]; presets: PresetView[]; cwd: string; layout: Layout; db: string }
  | { event: "agent"; agent: string; e: SessionEvent | { type: "prompt"; text: string; queued?: boolean } }
  | { event: "agents"; agents: AgentView[] }
  | { event: "jobs"; jobs: JobView[] }
  | { event: "permission"; ask: PermissionAsk }
  | { event: "permission_done"; reqId: string }
  | { event: "elicitation"; ask: ElicitationAsk }
  | { event: "elicitation_done"; reqId: string }
  | { event: "job"; text: string; jobId: number; agent: string }
  | { event: "error"; text: string };

/** UI → backend requests; each gets `{id, result}` or `{id, error}`. */
export interface Methods {
  addAgent: (p: PaneSpec & { resume?: boolean; startJob?: boolean }) => AgentView;
  worktrees: (p: Record<string, never>) => { repo: string; base: string; worktrees: WorktreeView[] }[];
  mergeWorktree: (p: { name: string; repo: string }) => { ok: boolean; message: string };
  removeAgent: (p: { name: string; forget?: boolean }) => void;
  prompt: (p: { name: string; text: string }) => void;
  broadcast: (p: { names: string[]; text: string }) => void;
  cancel: (p: { name: string }) => void;
  newSession: (p: { name: string }) => void;
  setConfig: (p: { name: string; configId: string; value: string | boolean }) => void;
  answerPermission: (p: { reqId: string; optionId: string }) => void;
  answerElicitation: (p: { reqId: string; action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }) => void;
  saveLayout: (p: Layout) => void;
  history: (p: { name: string; limit?: number }) => { ts: number; type: string; data: any }[];
  addJob: (p: {
    agent: string;
    kind: "loop" | "interval" | "watch" | "once";
    prompt: string;
    times?: number;
    forMs?: number;
    everyMs?: number;
    watchPath?: string;
    minLines?: number;
  }) => number;
  stopJob: (p: { id: number }) => void;
}

export type MethodName = keyof Methods;
export type Request = { id: number; method: MethodName; params: unknown };
export type Response = { id: number; result?: unknown; error?: string };
