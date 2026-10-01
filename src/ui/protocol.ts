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

export interface KindView {
  id: string;
  label: string;
  /** Pay-per-token API model (vs a CLI using your subscription). */
  api?: boolean;
  /** Env var it needs that isn't set. */
  missing?: string;
  install?: string;
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
  /** UI zoom (1 = 100%); Ctrl+= / Ctrl+- / Ctrl+0. */
  zoom?: number;
  /** auto: one column + no sidebar on tall/narrow windows (9:16 monitors). */
  orientation?: "auto" | "vertical" | "horizontal";
  /** Columns / sidebar used while the layout is vertical. */
  vcolumns?: number;
  vsidebar?: boolean;
  /** Chime when an agent finishes (default on). */
  ping?: boolean;
  theme?: "dark" | "light" | "oled" | "midnight" | "forest" | "ember" | "rose" | "paper";
  density?: "compact" | "comfortable" | "spacious";
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
  /** Current git branch of the agent's folder, if any. */
  branch?: string;
}

/** An agent in this hive that isn't running in this window. */
export interface OtherAgent {
  name: string;
  kind: string;
  cwd: string;
  role: string;
  policy?: string;
  status: string;
  note: string;
  unread: number;
  /** Where it runs, if somewhere: e.g. "hive serve (pid 123)". */
  where?: string;
}

export interface AccountView {
  id: string;
  label: string;
  api: boolean;
  /** true signed in / key works, false not signed in, null can't tell until it starts. */
  signedIn: boolean | null;
  installed: "ok" | "missing" | "npx";
  status: string;
  login?: string;
  install?: string;
  checkedAt: number;
}

export interface GroupView {
  name: string;
  members: string[];
  mode: "direct" | "review";
  maxPerHour: number | null;
  /** Messages waiting for you in this group. */
  held: number;
}

export interface MailView {
  id: number;
  ts: number;
  from_agent: string;
  to_agent: string;
  subject: string;
  body: string;
  thread: string | null;
  held?: string | null;
  via?: string | null;
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
  | { event: "ready"; kinds: KindView[]; presets: PresetView[]; cwd: string; layout: Layout; db: string }
  | { event: "agent"; agent: string; e: SessionEvent | { type: "prompt"; text: string; queued?: boolean } }
  | { event: "agents"; agents: AgentView[]; others?: OtherAgent[]; groups?: GroupView[]; mailScope?: "open" | "linked"; heldTotal?: number; guardAllowAll?: boolean }
  | { event: "jobs"; jobs: JobView[] }
  | { event: "permission"; ask: PermissionAsk }
  | { event: "permission_done"; reqId: string; outcome?: string }
  | { event: "elicitation"; ask: ElicitationAsk }
  | { event: "elicitation_done"; reqId: string; outcome?: string }
  | { event: "job"; text: string; jobId: number; agent: string }
  | { event: "error"; text: string }
  | { event: "fatal"; text: string }
  | { event: "verdict"; state: import("../core/verdict.js").VerdictState }
  | { event: "owner_mail"; unread: number; latest?: { from: string; subject: string } }
  /** Sent by Electron main, not the backend. */
  | { event: "backend_down"; text: string }
  | DeviceEvent;

// ---- device panes: sandboxed browser and Android (src/hive/devices.ts) ----
export type DeviceKind = "browser" | "android";
export type BrowserState = import("../hive/browser.js").BrowserState;
export type AndroidState = import("../hive/android.js").AndroidState;
export interface DeviceFrame {
  mime: string;
  /** base64 image */
  data: string;
  /** Size of the page / screen the frame shows (input coordinates map onto this). */
  w: number;
  h: number;
}
/** Frames go out only while a pane watches that device (deviceWatch). */
export type DeviceEvent =
  | { event: "device_frame"; device: DeviceKind; frame: DeviceFrame }
  | { event: "device_state"; device: "browser"; state: BrowserState }
  | { event: "device_state"; device: "android"; state: AndroidState }
  /** An agent used a device: the UI opens its pane. */
  | { event: "device_activity"; device: DeviceKind; agent: string; action: string }
  | { event: "device_problem"; device: DeviceKind; text: string };
export interface DeviceMethods {
  /** Start / stop the frame stream for a pane (stops when nobody watches). */
  deviceWatch: (p: { device: DeviceKind; on: boolean }) => void;
  browserState: (p: Record<string, never>) => BrowserState;
  browserOpen: (p: { url: string }) => BrowserState;
  browserNav: (p: { action: "back" | "forward" | "reload" | "stop" }) => BrowserState;
  browserInput: (p: import("../hive/browser.js").BrowserInput) => void;
  /** persistent: keep logins for this project (a profile folder in the project's state dir). */
  browserSettings: (p: { persistent: boolean }) => BrowserState;
  browserClose: (p: Record<string, never>) => void;
  androidState: (p: Record<string, never>) => AndroidState;
  androidSelect: (p: { serial: string | null }) => AndroidState;
  androidInput: (
    p:
      | { type: "tap"; x: number; y: number }
      | { type: "swipe"; x1: number; y1: number; x2: number; y2: number; ms?: number }
      | { type: "text"; text: string }
      | { type: "key"; key: string },
  ) => void;
  androidAction: (p: { action: "rotate" | "install" | "launch" | "startAvd"; value?: string }) => string;
}

/** UI → backend requests; each gets `{id, result}` or `{id, error}`. */
export interface Methods extends DeviceMethods {
  addAgent: (p: PaneSpec & { resume?: boolean; startJob?: boolean }) => AgentView;
  worktrees: (p: Record<string, never>) => { repo: string; base: string; worktrees: WorktreeView[] }[];
  mergeWorktree: (p: { name: string; repo: string }) => { ok: boolean; message: string };
  removeAgent: (p: { name: string; forget?: boolean; stopJobs?: boolean }) => void;
  getState: (p: Record<string, never>) => {
    ready: Extract<BackendEvent, { event: "ready" }>;
    agents: AgentView[];
    permissions: PermissionAsk[];
    elicitations: ElicitationAsk[];
    ownerUnread: number;
  };
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
    maxWaitMs?: number;
    cooldownMs?: number;
  }) => number;
  stopJob: (p: { id: number }) => void;
  report: (p: { sinceMs: number }) => import("../core/report.js").Report;
  hiveData: (p: Record<string, never>) => {
    blackboard: { key: string; value: string; updated_by: string; updated_at: number }[];
    messages: { id: number; ts: number; from_agent: string; to_agent: string; subject: string; body: string; thread: string | null; read_at: number | null }[];
    agents: string[];
  };
  sendMail: (p: { to: string; subject?: string; body: string }) => number;
  bbDelete: (p: { key: string }) => void;
  jobRuns: (p: { id: number }) => { iteration: number; started: number; ended: number | null; stop_reason: string | null; error: string | null; summary: string | null; tokens?: number }[];
  markOwnerRead: (p: Record<string, never>) => void;
  recipes: (p: Record<string, never>) => { id: string; label: string; description: string; agents: { name: string; alt?: boolean; interactive?: boolean }[]; next: string }[];
  applyRecipe: (p: { id: string; kind: string; alt?: string; prefix?: string }) => {
    agents: { name: string; kind: string; interactive: boolean; policy: string; role: string; worktree: boolean; preset?: string }[];
    groups: string[];
    jobs: number[];
    next: string;
  };
  skills: (p: Record<string, never>) => {
    name: string;
    description: string;
    source: string;
    agent?: string;
    policy: string;
    output?: string;
    params: { name: string; type: string; required?: boolean; default?: string; description?: string; choices?: string[] }[];
  }[];
  runSkill: (p: { name: string; params: Record<string, string>; kind?: string }) => { agent: string; kind: string; policy: Policy };
  groups: (p: Record<string, never>) => { name: string; members: string[] }[];
  accounts: (p: { refresh?: boolean }) => AccountView[];
  startVerdict: (p: { prompt: string; kinds: string[]; judge: string; judgeModel?: string; mode: "code" | "text"; policy?: Policy }) => { id: number };
  applyVerdict: (p: { id: number; label?: string }) => void;
  verdicts: (p: Record<string, never>) => import("../core/verdict.js").VerdictState[];
  link: (p: { members: string[]; name?: string; mode?: "direct" | "review"; maxPerHour?: number | null; includeOwner?: boolean }) => GroupView;
  groupChat: (p: { name: string }) => { group: GroupView; messages: MailView[] };
  setGroup: (p: { name: string; mode?: "direct" | "review"; maxPerHour?: number | null; remove?: string; add?: string; delete?: boolean }) => GroupView | null;
  releaseMail: (p: { id: number; body?: string }) => void;
  dropMail: (p: { id: number }) => void;
  setScope: (p: { scope: "open" | "linked" }) => void;
  setGuard: (p: { on: boolean }) => void;
  heldMail: (p: Record<string, never>) => MailView[];
  saveSkill: (p: { name: string; description?: string; body: string; overwrite?: boolean }) => { path: string; params: string[] };
  usage: (p: Record<string, never>) => import("../core/budget.js").UsageSummary;
  stats: (p: { by: import("../core/ledger.js").LedgerDim; filter: import("../core/ledger.js").LedgerFilter }) => ReturnType<typeof import("../core/ledger.js").stats> & {
    facets: ReturnType<typeof import("../core/ledger.js").facets>;
  };
  setBudget: (p: { key: string; value: string }) => import("../core/budget.js").UsageSummary;
  board: (p: { done?: boolean; project?: string; q?: string }) => {
    cards: import("../hive/kanban.js").Card[];
    counts: Record<import("../hive/kanban.js").Column, number>;
    projects: string[];
  };
  cardAdd: (p: { title: string; body?: string; project?: string; labels?: string[]; col?: import("../hive/kanban.js").Column }) => import("../hive/kanban.js").Card;
  cardMove: (p: { id: number; col: import("../hive/kanban.js").Column; before?: number | null }) => import("../hive/kanban.js").Card;
  cardUpdate: (p: { id: number; title?: string; body?: string; project?: string; labels?: string[] }) => import("../hive/kanban.js").Card;
  cardRemove: (p: { id: number }) => boolean;
}

export type MethodName = keyof Methods;
export type Request = { id: number; method: MethodName; params: unknown };
export type Response = { id: number; result?: unknown; error?: string };
