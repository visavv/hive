/**
 * AgentSession: one running ACP agent, wired into the hive.
 *
 * - spawns the vendor adapter subprocess
 * - injects the hive MCP server (identity via env, so the agent can't lie about who it is)
 * - forwards permission requests to a policy (ask / allow-reads / allow-all)
 * - emits typed events the UI (or CLI) renders
 * - delivers unread hive mail as a prompt when the agent is idle
 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type * as schema from "@agentclientprotocol/sdk";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { AGENTS, resolveEnv, type AgentDef } from "./agents.js";
import { HiveDb } from "../hive/db.js";

export type PermissionPolicy = "ask" | "allow-reads" | "allow-all" | "reject-all";

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
  askPermission?: (req: schema.RequestPermissionRequest) => Promise<string>;
  /** Text prepended to the very first prompt (system-ish briefing). */
  briefing?: string;
}

export type SessionEvent =
  | { type: "text"; text: string }
  | { type: "thought"; text: string }
  | { type: "tool_call"; id: string; title: string; status: string; kind?: string }
  | { type: "tool_update"; id: string; status?: string; title?: string; raw: unknown }
  | { type: "plan"; entries: unknown }
  | { type: "usage"; usage: unknown }
  | { type: "permission"; title: string; decision: string }
  | { type: "turn_end"; stopReason: string; usage?: unknown }
  | { type: "status"; status: "idle" | "working" | "waiting" | "error"; note?: string }
  | { type: "notice"; text: string }
  | { type: "raw"; update: schema.SessionUpdate }
  | { type: "exit"; code: number | null };

const here = dirname(fileURLToPath(import.meta.url));
// src/core -> src/hive/server.ts (tsx) or dist/hive/server.js (built)
const isTs = here.endsWith("src/core") || here.endsWith("src\\core");
const hiveServerPath = join(here, "..", "hive", isTs ? "server.ts" : "server.js");

export class AgentSession extends EventEmitter<{ event: [SessionEvent] }> {
  readonly name: string;
  readonly def: AgentDef;
  readonly cwd: string;
  readonly role: string;
  private proc!: ChildProcess;
  private session!: acp.ActiveSession;
  private db: HiveDb;
  private policy: PermissionPolicy;
  private askPermission?: SessionOptions["askPermission"];
  private briefing?: string;
  private firstPrompt = true;
  private busy = false;
  private queue: string[] = [];
  private closed = false;
  private ready!: Promise<void>;
  private resolveReady!: () => void;
  private closedP!: Promise<void>;
  private resolveClosed!: () => void;
  private connectionDone!: Promise<unknown>;

  constructor(private opts: SessionOptions) {
    super();
    this.name = opts.name;
    this.def = typeof opts.agent === "string" ? AGENTS[opts.agent] : opts.agent;
    if (!this.def) throw new Error(`unknown agent "${opts.agent}"`);
    this.cwd = resolve(opts.cwd);
    this.role = opts.role ?? "";
    this.db = new HiveDb(opts.hiveDb);
    this.policy = opts.policy ?? "ask";
    this.askPermission = opts.askPermission;
    this.briefing = opts.briefing;
    this.ready = new Promise((r) => (this.resolveReady = r));
    this.closedP = new Promise((r) => (this.resolveClosed = r));
  }

  get busyNow() {
    return this.busy;
  }

  async start(): Promise<void> {
    const env = { ...process.env, ...resolveEnv(this.def) };
    this.proc = spawn(this.def.command, this.def.args, {
      cwd: this.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    this.proc.stderr?.on("data", (d) => this.emitEv({ type: "notice", text: `[stderr] ${String(d).trimEnd()}` }));
    this.proc.on("exit", (code) => {
      this.closed = true;
      this.db.setStatus(this.name, "asleep", `exited ${code}`);
      this.emitEv({ type: "exit", code });
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
      session_id: null,
    });

    // connectWith resolves when the callback resolves; we keep the callback
    // alive for the life of the session so the connection stays open.
    this.connectionDone = acp
      .client({ name: "hive" })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => this.onPermission(ctx.params))
      .onRequest(acp.methods.client.fs.readTextFile, async (ctx) => ({
        content: await readFile(ctx.params.path, "utf8"),
      }))
      .onRequest(acp.methods.client.fs.writeTextFile, async (ctx) => {
        await mkdir(dirname(ctx.params.path), { recursive: true });
        await writeFile(ctx.params.path, ctx.params.content, "utf8");
        return {};
      })
      .connectWith(stream, async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        });
        const session = await ctx
          .buildSession(this.cwd)
          .withMcpServer({
            name: "hive",
            command: process.execPath,
            // dev: node <tsx> server.ts   prod: node server.js
            args: isTs ? [tsxCli(), hiveServerPath] : [hiveServerPath],
            env: [
              { name: "HIVE_DB", value: resolve(this.opts.hiveDb) },
              { name: "HIVE_AGENT", value: this.name },
            ],
          })
          .start();
        this.session = session;
        this.db.upsertAgent({
          name: this.name,
          kind: this.def.id,
          cwd: this.cwd,
          role: this.role,
          status: "idle",
          status_note: "",
          session_id: session.sessionId,
        });
        this.resolveReady();
        // Park here until closed; the update loop runs per prompt.
        await this.closedP;
      })
      .catch((err) => {
        this.emitEv({ type: "status", status: "error", note: String(err?.message ?? err) });
        this.db.setStatus(this.name, "error", String(err?.message ?? err));
      });

    await this.ready;
  }

  /** Send a prompt. If busy, queue it. Returns when the turn ends. */
  async prompt(text: string): Promise<void> {
    if (this.busy) {
      this.queue.push(text);
      return;
    }
    await this.runTurn(text);
    // drain queue and any hive mail
    while (!this.closed) {
      const next = this.queue.shift() ?? this.pendingMailPrompt();
      if (!next) break;
      await this.runTurn(next);
    }
  }

  /** If idle and mail is waiting, deliver it. Returns true if a turn ran. */
  async poke(): Promise<boolean> {
    if (this.busy || this.closed) return false;
    const p = this.queue.shift() ?? this.pendingMailPrompt();
    if (!p) return false;
    await this.prompt(p);
    return true;
  }

  async cancel() {
    if (!this.session) return;
    // session/cancel is a notification on the agent side
    await (this.session as any).cx?.notify?.(acp.methods.agent.session.cancel, {
      sessionId: this.session.sessionId,
    });
  }

  async close() {
    this.closed = true;
    this.resolveClosed();
    this.db.setStatus(this.name, "asleep", "closed");
    this.proc?.kill();
    this.db.close();
  }

  // ---- internals ----

  private pendingMailPrompt(): string | undefined {
    if (this.db.unreadCount(this.name) === 0) return undefined;
    return `You have unread hive mail. Call hive_inbox, act on anything addressed to you, reply with hive_send where a reply is expected, then continue or stop.`;
  }

  private async runTurn(text: string) {
    this.busy = true;
    this.db.setStatus(this.name, "working", text.slice(0, 120));
    this.emitEv({ type: "status", status: "working", note: text.slice(0, 120) });
    this.db.log(this.name, "prompt", { text });

    let full = text;
    if (this.firstPrompt) {
      this.firstPrompt = false;
      full = `${this.briefingText()}\n\n---\n\n${text}`;
    }

    const done = this.session.prompt(full);
    for (;;) {
      const msg = await this.session.nextUpdate();
      if (msg.kind === "stop") {
        this.emitEv({ type: "turn_end", stopReason: msg.stopReason, usage: msg.response.usage ?? undefined });
        this.db.log(this.name, "turn_end", { stopReason: msg.stopReason, usage: msg.response.usage });
        break;
      }
      this.handleUpdate(msg.update);
    }
    await done.catch(() => {});
    this.busy = false;
    this.db.setStatus(this.name, "idle", "");
    this.emitEv({ type: "status", status: "idle" });
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
      this.briefing ?? "",
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
        this.emitEv({ type: "usage", usage: u });
        break;
      case "notice":
        this.emitEv({ type: "notice", text: JSON.stringify((u as any).content ?? u) });
        break;
      default:
        this.emitEv({ type: "raw", update: u });
    }
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
      if (this.askPermission) {
        const id = await this.askPermission(req);
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

  private emitEv(e: SessionEvent) {
    this.emit("event", e);
  }
}

/** Path to the tsx CLI so the hive MCP server can run from source in dev. */
function tsxCli(): string {
  return fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));
}
