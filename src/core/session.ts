/**
 * AgentSession: one running ACP agent, wired into the hive.
 *
 * - spawns the vendor adapter subprocess
 * - injects the hive MCP server (identity via env, so the agent can't lie about who it is)
 * - resumes the previous ACP session when asked and the agent supports it
 * - forwards permission requests to a policy (ask / allow-reads / allow-all)
 * - forwards elicitation requests (structured questions) to a handler
 * - emits typed events the UI (or CLI) renders
 * - delivers unread hive mail as a prompt when the agent is idle
 *
 * Updates are routed by sessionId from a connection-wide `session/update`
 * handler rather than through the SDK's ActiveSession helper, so a single
 * agent process can hold a new, loaded, resumed or fresh (scheduler) session.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { dirname, isAbsolute, resolve } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type * as schema from "@agentclientprotocol/sdk";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { AGENTS, resolveEnv, spawnSpec, type AgentDef } from "./agents.js";
import { nodeEntry } from "./paths.js";
import { AUTH_STATUS_UPDATE, authLabel, type AuthStatus } from "./doctor.js";
import { HiveDb } from "../hive/db.js";

export type PermissionPolicy = "ask" | "allow-reads" | "allow-all" | "reject-all";
export const POLICIES: PermissionPolicy[] = ["ask", "allow-reads", "allow-all", "reject-all"];

export interface SessionOptions {
  /** Unique hive name, e.g. "wombat". */
  name: string;
  /** Key into AGENTS or a custom AgentDef. */
  agent: string | AgentDef;
  cwd: string;
  /** Free-text role shown to other agents ("security reviewer", "coder"). */
  role?: string;
  hiveDb: string;
  policy?: PermissionPolicy;
  /** Called for "ask" policy; return the optionId to select. */
  askPermission?: (req: schema.RequestPermissionRequest, agent: string) => Promise<string>;
  /**
   * Called when the agent asks the user a structured question
   * (`elicitation/create`). Without a handler hive declines.
   */
  elicit?: (req: schema.CreateElicitationRequest, agent: string) => Promise<schema.CreateElicitationResponse>;
  /** Text prepended to the very first prompt (system-ish briefing). */
  briefing?: string;
  /** Try to resume this ACP session (session/resume, else session/load) before creating a new one. */
  resumeSessionId?: string;
  /** Max ms to wait for the agent to initialize and open a session. */
  startTimeoutMs?: number;
}

export interface TurnResult {
  stopReason: string;
  usage?: unknown;
  error?: string;
}

export type SessionEvent =
  | { type: "text"; text: string }
  | { type: "thought"; text: string }
  | { type: "tool_call"; id: string; title: string; status: string; kind?: string }
  | { type: "tool_update"; id: string; status?: string; title?: string; raw: unknown }
  | { type: "plan"; entries: unknown }
  | { type: "usage"; usage: unknown }
  | { type: "context"; used: number; size: number }
  | { type: "config"; options: schema.SessionConfigOption[] }
  | { type: "permission"; title: string; decision: string }
  | { type: "elicitation"; message: string; action: string }
  | { type: "session"; sessionId: string; how: "new" | "resumed" | "loaded" | "fresh" }
  | { type: "auth"; status: AuthStatus; label: string }
  | { type: "turn_end"; stopReason: string; usage?: unknown }
  | { type: "status"; status: "idle" | "working" | "waiting" | "error"; note?: string }
  | { type: "notice"; text: string }
  | { type: "raw"; update: schema.SessionUpdate }
  | { type: "exit"; code: number | null };

type QueueItem =
  | { kind: "update"; update: schema.SessionUpdate }
  | { kind: "stop"; response: schema.PromptResponse }
  | { kind: "error"; error: unknown };

/** Minimal async queue: push never blocks, next() waits for the next item. */
class Queue<T> {
  private items: T[] = [];
  private waiters: ((v: T) => void)[] = [];
  push(v: T) {
    const w = this.waiters.shift();
    if (w) w(v);
    else this.items.push(v);
  }
  next(): Promise<T> {
    const v = this.items.shift();
    if (v !== undefined) return Promise.resolve(v);
    return new Promise((r) => this.waiters.push(r));
  }
  clear() {
    this.items = [];
  }
}

const hiveServer = nodeEntry("hive/server");

export class AgentSession extends EventEmitter<{ event: [SessionEvent] }> {
  readonly name: string;
  readonly def: AgentDef;
  readonly cwd: string;
  readonly role: string;
  private proc!: ChildProcess;
  private ctx?: acp.ClientContext;
  private sessionIdValue?: string;
  private caps: schema.AgentCapabilities = {};
  private initResponse?: schema.InitializeResponse;
  private updates = new Queue<QueueItem>();
  private db: HiveDb;
  private policy: PermissionPolicy;
  private firstPrompt = true;
  private busy = false;
  private queue: string[] = [];
  private closed = false;
  private disposed = false;
  private closedP!: Promise<void>;
  private resolveClosed!: () => void;
  private connectionDone?: Promise<unknown>;
  private lastActivity = Date.now();
  /** Latest context-window usage from `usage_update` (for the UI's ctx %). */
  context?: { used: number; size: number };
  /** Identity the agent reports via `_auth/status_update` (kind "none" = logged out). */
  authStatus?: AuthStatus;
  /** Latest model/effort/etc. selectors the agent exposes. */
  configOptions: schema.SessionConfigOption[] = [];

  constructor(private opts: SessionOptions) {
    super();
    this.name = opts.name;
    this.def = typeof opts.agent === "string" ? AGENTS[opts.agent] : opts.agent;
    if (!this.def) throw new Error(`unknown agent "${opts.agent}" (known: ${Object.keys(AGENTS).join(", ")})`);
    this.cwd = resolve(opts.cwd);
    this.role = opts.role ?? "";
    this.db = new HiveDb(opts.hiveDb);
    this.policy = opts.policy ?? "ask";
    if (!POLICIES.includes(this.policy)) throw new Error(`unknown policy "${this.policy}" (use ${POLICIES.join(", ")})`);
    this.closedP = new Promise((r) => (this.resolveClosed = r));
  }

  get busyNow() {
    return this.busy;
  }
  get isClosed() {
    return this.closed;
  }
  get sessionId(): string | undefined {
    return this.sessionIdValue;
  }
  get capabilities(): schema.AgentCapabilities {
    return this.caps;
  }
  get agentInfo() {
    return this.initResponse?.agentInfo ?? undefined;
  }
  /** Ms since the last turn ended (or started, while busy). */
  get idleMs() {
    return this.busy ? 0 : Date.now() - this.lastActivity;
  }
  get queued() {
    return this.queue.length;
  }
  /** True while the current ACP session is brand new and has never been prompted. */
  get pristine() {
    return this.firstPrompt;
  }

  async start(): Promise<void> {
    const env = { ...process.env, ...resolveEnv(this.def) };
    const spec = spawnSpec(this.def);
    this.proc = spawn(spec.command, spec.args, {
      cwd: this.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: spec.shell,
      windowsHide: true,
    });
    this.proc.stderr?.on("data", (d) => this.emitEv({ type: "notice", text: `[stderr] ${String(d).trimEnd()}` }));
    let startFailed: ((e: Error) => void) | undefined;
    this.proc.on("error", (err) => {
      this.emitEv({ type: "status", status: "error", note: `spawn failed: ${err.message}` });
      startFailed?.(new Error(`${this.def.id}: could not start "${this.def.command}": ${err.message}. ${this.def.install}`));
    });
    this.proc.on("exit", (code) => {
      const wasClosed = this.closed;
      this.closed = true;
      if (!this.db.db.open) return;
      this.db.setStatus(this.name, "asleep", wasClosed ? "closed" : `exited ${code}`);
      this.emitEv({ type: "exit", code });
      // Unblock a turn that was waiting on this process.
      this.updates.push({ kind: "error", error: new Error(`agent process exited (${code})`) });
      startFailed?.(new Error(`${this.def.id} exited during startup (code ${code})`));
    });

    const input = Writable.toWeb(this.proc.stdin!);
    const output = Readable.toWeb(this.proc.stdout!) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);

    this.db.upsertAgent({
      name: this.name,
      kind: this.def.id,
      cwd: this.cwd,
      role: this.role,
      status: "idle",
      status_note: "starting",
      session_id: this.opts.resumeSessionId ?? null,
    });

    const ready = new Promise<void>((resolveReady, rejectReady) => {
      startFailed = rejectReady;
      // connectWith resolves when the callback resolves; we keep the callback
      // alive for the life of the session so the connection stays open.
      this.connectionDone = acp
        .client({ name: "hive" })
        .onRequest(acp.methods.client.session.requestPermission, (c) => this.onPermission(c.params))
        .onRequest(acp.methods.client.elicitation.create, (c) => this.onElicitation(c.params))
        .onNotification(acp.methods.client.session.update, (c) => this.onUpdate(c.params))
        .onNotification(AUTH_STATUS_UPDATE, (p: unknown) => p as { authStatus?: AuthStatus }, (c) => {
          const a = c.params.authStatus;
          if (!a) return;
          this.authStatus = a;
          this.emitEv({ type: "auth", status: a, label: a.kind === "none" ? "not logged in" : authLabel(a) });
        })
        .onRequest(acp.methods.client.fs.readTextFile, async (c) => ({
          content: sliceLines(await readFile(this.checkPath(c.params.path), "utf8"), c.params.line, c.params.limit),
        }))
        .onRequest(acp.methods.client.fs.writeTextFile, async (c) => {
          const p = this.checkPath(c.params.path);
          await mkdir(dirname(p), { recursive: true });
          await writeFile(p, c.params.content, "utf8");
          return {};
        })
        .connectWith(stream, async (ctx) => {
          this.ctx = ctx;
          this.initResponse = await ctx.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {
              fs: { readTextFile: true, writeTextFile: true },
              ...(this.opts.elicit ? { elicitation: { form: {} } } : {}),
            },
          });
          this.caps = this.initResponse.agentCapabilities ?? {};
          await this.openSession(this.opts.resumeSessionId);
          resolveReady();
          // Park here until closed; turns run from prompt().
          await this.closedP;
        })
        .catch((err) => {
          const msg = String(err?.message ?? err);
          if (!this.closed) {
            this.emitEv({ type: "status", status: "error", note: msg });
            if (this.db.db.open) this.db.setStatus(this.name, "error", msg);
          }
          this.updates.push({ kind: "error", error: err });
          rejectReady(err);
        });
    });

    const timeout = this.opts.startTimeoutMs ?? 120_000;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        ready,
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error(`${this.def.id}: no ACP session after ${timeout} ms`)), timeout);
        }),
      ]);
    } catch (e) {
      await this.close();
      throw e;
    } finally {
      clearTimeout(timer);
      startFailed = undefined;
    }
  }

  /**
   * Replace the current ACP session with a brand-new one on the same agent
   * process. The scheduler uses this so every loop iteration starts from an
   * empty context (the Ralph-loop pattern) without paying for a new process.
   */
  async newSession(): Promise<string> {
    if (!this.ctx) throw new Error("session not started");
    if (this.busy) throw new Error(`${this.name} is busy`);
    const old = this.sessionIdValue;
    if (old && this.caps.sessionCapabilities?.close) {
      await this.ctx.request(acp.methods.agent.session.close, { sessionId: old }).catch(() => {});
    }
    await this.openSession(undefined, "fresh");
    return this.sessionIdValue!;
  }

  /** Send a prompt. If busy, queue it. Returns when the turn (and queued work) ends. */
  async prompt(text: string): Promise<void> {
    if (this.busy) {
      this.queue.push(text);
      this.emitEv({ type: "notice", text: `queued (${this.queue.length} waiting)` });
      return;
    }
    await this.runTurn(text);
    await this.drain();
  }

  /**
   * Run exactly one turn and report how it ended. Waits for the agent to be
   * idle first. Used by the scheduler, which needs the stop reason and usage.
   */
  async runOnce(text: string): Promise<TurnResult> {
    while (this.busy) await new Promise((r) => setTimeout(r, 100));
    const r = await this.runTurn(text);
    void this.drain();
    return r;
  }

  /** If idle and mail is waiting, deliver it. Returns true if a turn ran. */
  async poke(): Promise<boolean> {
    if (this.busy || this.closed) return false;
    const p = this.queue.shift() ?? this.pendingMailPrompt();
    if (!p) return false;
    await this.prompt(p);
    return true;
  }

  /** Ask the agent to stop the current turn (`session/cancel` notification). */
  async cancel() {
    if (!this.ctx || !this.sessionIdValue) return;
    this.queue = [];
    await this.ctx.notify(acp.methods.agent.session.cancel, { sessionId: this.sessionIdValue });
  }

  /** Change a model/effort/mode selector the agent advertised via configOptions. */
  async setConfigOption(configId: string, value: string | boolean) {
    if (!this.ctx || !this.sessionIdValue) throw new Error("session not started");
    const params =
      typeof value === "boolean"
        ? { sessionId: this.sessionIdValue, configId, type: "boolean" as const, value }
        : { sessionId: this.sessionIdValue, configId, value };
    const r = (await this.ctx.request(acp.methods.agent.session.setConfigOption, params)) as {
      configOptions?: schema.SessionConfigOption[];
    };
    if (r?.configOptions) this.setConfig(r.configOptions);
  }

  async close() {
    if (this.disposed) return;
    this.disposed = true;
    this.closed = true;
    this.resolveClosed();
    if (this.db.db.open) {
      this.db.setStatus(this.name, "asleep", "closed");
      this.db.close();
    }
    this.proc?.kill();
  }

  // ---- internals ----

  private hiveMcp(): schema.McpServer {
    return {
      name: "hive",
      command: hiveServer.command,
      args: hiveServer.args,
      env: [
        { name: "HIVE_DB", value: resolve(this.opts.hiveDb) },
        { name: "HIVE_AGENT", value: this.name },
      ],
    };
  }

  /** Resume `resumeId` if possible, otherwise create a new session. */
  private async openSession(resumeId?: string, freshHow: "new" | "fresh" = "new") {
    const ctx = this.ctx!;
    let how: "new" | "resumed" | "loaded" | "fresh" = freshHow;
    let sid: string | undefined;
    let cfg: schema.SessionConfigOption[] | null | undefined;
    if (resumeId) {
      try {
        if (this.caps.sessionCapabilities?.resume) {
          // Listen before asking so nothing sent during resume is dropped.
          this.sessionIdValue = resumeId;
          const r = await ctx.request(acp.methods.agent.session.resume, {
            sessionId: resumeId,
            cwd: this.cwd,
            mcpServers: [this.hiveMcp()],
          });
          cfg = r?.configOptions;
          sid = resumeId;
          how = "resumed";
        } else if (this.caps.loadSession) {
          // session/load replays history as session/update notifications;
          // drop them rather than re-rendering the whole conversation. They
          // may be dispatched after the response, so suppression lasts until
          // the next prompt starts.
          this.sessionIdValue = undefined;
          this.replayingId = resumeId;
          const r = await ctx.request(acp.methods.agent.session.load, {
            sessionId: resumeId,
            cwd: this.cwd,
            mcpServers: [this.hiveMcp()],
          });
          cfg = r?.configOptions;
          sid = resumeId;
          how = "loaded";
        }
      } catch (e: any) {
        this.emitEv({ type: "notice", text: `could not resume ${resumeId}: ${e?.message ?? e}; starting a new session` });
        sid = undefined;
        this.replayingId = undefined;
      }
    }
    if (!sid) {
      const r = await ctx.request(acp.methods.agent.session.new, { cwd: this.cwd, mcpServers: [this.hiveMcp()] });
      sid = r.sessionId;
      cfg = r.configOptions;
    }
    this.sessionIdValue = sid;
    this.updates.clear();
    // A resumed conversation already has the briefing; a new one needs it.
    this.firstPrompt = how === "new" || how === "fresh";
    if (cfg) this.setConfig(cfg);
    this.db.upsertAgent({
      name: this.name,
      kind: this.def.id,
      cwd: this.cwd,
      role: this.role,
      status: "idle",
      status_note: "",
      session_id: sid,
    });
    this.db.log(this.name, "session", { sessionId: sid, how });
    this.emitEv({ type: "session", sessionId: sid, how });
  }
  private replayingId?: string;

  private onUpdate(n: schema.SessionNotification) {
    const replay = n.sessionId === this.replayingId && !this.busy;
    if (!replay && n.sessionId !== this.sessionIdValue) return;
    const u = n.update;
    // State the UI wants even between turns (and from replayed history).
    if (u.sessionUpdate === "usage_update") this.context = { used: u.used, size: u.size };
    if (u.sessionUpdate === "config_option_update") this.setConfig(u.configOptions);
    if (replay) return;
    if (this.busy) this.updates.push({ kind: "update", update: u });
    else this.handleUpdate(u);
  }

  private setConfig(options: schema.SessionConfigOption[]) {
    this.configOptions = options;
    this.emitEv({ type: "config", options });
  }

  private pendingMailPrompt(): string | undefined {
    const from = this.db.unreadSummary(this.name);
    if (!from.length) return undefined;
    const total = from.reduce((n, f) => n + f.count, 0);
    const list = from
      .map((f) => {
        const subj = f.subjects.slice(0, 3).map((s) => JSON.stringify(s.slice(0, 60))).join(", ");
        return `${f.count} from ${f.from}${subj ? ` (${subj}${f.subjects.length > 3 ? ", …" : ""})` : ""}`;
      })
      .join("; ");
    return `You have ${total} unread hive message${total === 1 ? "" : "s"}: ${list}. Call hive_inbox, act on anything addressed to you, reply with hive_send where a reply is expected, then continue or stop.`;
  }

  private async drain() {
    while (!this.closed && !this.busy) {
      const next = this.queue.shift() ?? this.pendingMailPrompt();
      if (!next) break;
      await this.runTurn(next);
    }
  }

  private async runTurn(text: string): Promise<TurnResult> {
    if (!this.ctx || !this.sessionIdValue) throw new Error(`${this.name}: session not started`);
    if (this.closed) return { stopReason: "closed", error: "session closed" };
    this.busy = true;
    this.lastActivity = Date.now();
    this.db.setStatus(this.name, "working", text.slice(0, 120));
    this.emitEv({ type: "status", status: "working", note: text.slice(0, 120) });
    this.db.log(this.name, "prompt", { text });

    let full = text;
    if (this.firstPrompt) {
      this.firstPrompt = false;
      full = `${this.briefingText()}\n\n---\n\n${text}`;
    }

    let result: TurnResult = { stopReason: "error" };
    this.updates.clear();
    this.replayingId = undefined;
    const sessionId = this.sessionIdValue;
    try {
      this.ctx
        .request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: full }] })
        .then(
          (response) => this.updates.push({ kind: "stop", response }),
          (error) => this.updates.push({ kind: "error", error }),
        );
      for (;;) {
        const msg = await this.updates.next();
        if (msg.kind === "update") {
          this.handleUpdate(msg.update);
          continue;
        }
        if (msg.kind === "stop") {
          result = { stopReason: msg.response.stopReason, usage: msg.response.usage ?? undefined };
        } else {
          const err = String((msg.error as any)?.message ?? msg.error);
          result = { stopReason: "error", error: err };
          this.emitEv({ type: "notice", text: `turn failed: ${err}` });
        }
        break;
      }
    } finally {
      this.emitEv({ type: "turn_end", stopReason: result.stopReason, usage: result.usage });
      if (this.db.db.open) {
        this.db.log(this.name, "turn_end", { stopReason: result.stopReason, usage: result.usage, error: result.error });
        this.db.setStatus(this.name, this.closed ? "asleep" : result.error ? "error" : "idle", result.error ?? "");
      }
      this.busy = false;
      this.lastActivity = Date.now();
      this.emitEv({ type: "status", status: result.error ? "error" : "idle", note: result.error });
    }
    return result;
  }

  private briefingText() {
    const others = this.db
      .listAgents()
      .filter((a) => a.name !== this.name)
      .map((a) => `- ${a.name} (${a.kind}${a.role ? ", " + a.role : ""})`)
      .join("\n");
    return [
      `You are agent "${this.name}"${this.role ? ` with role: ${this.role}` : ""} in a local multi-agent hive.`,
      `Other agents:\n${others || "- (none yet)"}`,
      `You have MCP tools prefixed hive_: use hive_inbox at the start of each turn, hive_send to hand work or findings to another agent, hive_bb_* for shared project facts and task claims (key "claim/<task>"), hive_status to publish what you're doing.`,
      `Never wait or poll for replies inside a turn; send, finish your own work, and the hub will wake you when mail arrives.`,
      this.opts.briefing ?? "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private handleUpdate(u: schema.SessionUpdate) {
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content.type === "text") this.emitEv({ type: "text", text: u.content.text });
        break;
      case "agent_thought_chunk":
        if (u.content.type === "text") this.emitEv({ type: "thought", text: u.content.text });
        break;
      case "tool_call":
        this.emitEv({ type: "tool_call", id: u.toolCallId, title: u.title, status: u.status ?? "pending", kind: u.kind ?? undefined });
        this.db.log(this.name, "tool_call", { id: u.toolCallId, title: u.title, kind: u.kind });
        break;
      case "tool_call_update":
        this.emitEv({ type: "tool_update", id: u.toolCallId, status: u.status ?? undefined, title: u.title ?? undefined, raw: u });
        break;
      case "plan":
      case "plan_update":
        this.emitEv({ type: "plan", entries: (u as any).entries });
        break;
      case "usage_update":
        this.emitEv({ type: "context", used: u.used, size: u.size });
        this.emitEv({ type: "usage", usage: u });
        break;
      case "config_option_update":
        break; // already emitted as "config" by onUpdate
      case "notice":
        this.emitEv({ type: "notice", text: JSON.stringify((u as any).content ?? u) });
        break;
      default:
        this.emitEv({ type: "raw", update: u });
    }
  }

  /** Agents must send absolute paths; refuse anything else. */
  private checkPath(p: string): string {
    if (!isAbsolute(p)) throw new Error(`path must be absolute: ${p}`);
    return p;
  }

  private async onPermission(req: schema.RequestPermissionRequest): Promise<schema.RequestPermissionResponse> {
    const pick = (kinds: schema.PermissionOptionKind[]) =>
      kinds.map((k) => req.options.find((o) => o.kind === k)).find(Boolean) ?? req.options[0];
    const title = req.toolCall.title ?? "tool";
    const kind = (req.toolCall as any).kind as string | undefined;
    let opt: schema.PermissionOption | undefined;
    switch (this.policy) {
      case "allow-all":
        opt = pick(["allow_once", "allow_always"]);
        break;
      case "reject-all":
        opt = pick(["reject_once", "reject_always"]);
        break;
      case "allow-reads":
        opt =
          kind === "read" || kind === "search" || kind === "fetch" || kind === "think"
            ? pick(["allow_once", "allow_always"])
            : undefined;
        break;
    }
    if (!opt) {
      this.db.setStatus(this.name, "waiting", `permission: ${title}`);
      this.emitEv({ type: "status", status: "waiting", note: `permission: ${title}` });
      if (this.opts.askPermission) {
        const id = await this.opts.askPermission(req, this.name);
        opt = req.options.find((o) => o.optionId === id) ?? pick(["reject_once"]);
      } else {
        opt = pick(["reject_once", "reject_always"]);
      }
      this.db.setStatus(this.name, "working", "");
    }
    this.emitEv({ type: "permission", title, decision: opt.kind });
    this.db.log(this.name, "permission", { title, kind, decision: opt.kind });
    return { outcome: { outcome: "selected", optionId: opt.optionId } };
  }

  private async onElicitation(req: schema.CreateElicitationRequest): Promise<schema.CreateElicitationResponse> {
    let res: schema.CreateElicitationResponse = { action: "decline" };
    if (this.opts.elicit) {
      this.db.setStatus(this.name, "waiting", `question: ${req.message.slice(0, 100)}`);
      this.emitEv({ type: "status", status: "waiting", note: `question: ${req.message.slice(0, 100)}` });
      try {
        res = await this.opts.elicit(req, this.name);
      } catch {
        res = { action: "cancel" };
      }
      this.db.setStatus(this.name, "working", "");
    }
    this.emitEv({ type: "elicitation", message: req.message, action: res.action });
    this.db.log(this.name, "elicitation", { message: req.message, action: res.action });
    return res;
  }

  private emitEv(e: SessionEvent) {
    this.emit("event", e);
  }
}

/** Apply ACP's 1-based `line` and `limit` to file content. */
export function sliceLines(content: string, line?: number | null, limit?: number | null): string {
  if (line == null && limit == null) return content;
  const lines = content.split("\n");
  const start = Math.max(0, (line ?? 1) - 1);
  const end = limit == null ? lines.length : start + Math.max(0, limit);
  return lines.slice(start, end).join("\n");
}
