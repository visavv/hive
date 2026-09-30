/**
 * Hub: owns every AgentSession in one hive and runs the delivery loop that
 * wakes idle agents when they have unread mail. The scheduler and (later) the
 * UI sit on top of this.
 */
import { AgentSession, type SessionOptions, type SessionEvent } from "./session.js";
import { HiveDb } from "../hive/db.js";
import { resolve } from "node:path";

export interface HubOptions {
  hiveDb: string;
  /** Mail delivery poll interval. */
  pollMs?: number;
  onEvent?: (agent: string, e: SessionEvent) => void;
  /** Defaults applied to every add() (e.g. the CLI's permission/elicitation prompts). */
  defaults?: Partial<Pick<SessionOptions, "askPermission" | "elicit" | "briefing" | "startTimeoutMs">>;
}

export type AddOptions = Omit<SessionOptions, "hiveDb"> & {
  /**
   * Resume this agent's previous ACP session (stored in the agents table) if
   * it was the same vendor in the same cwd and the vendor supports it.
   */
  resume?: boolean;
};

export class Hub {
  readonly sessions = new Map<string, AgentSession>();
  readonly db: HiveDb;
  readonly hiveDb: string;
  private timer?: NodeJS.Timeout;
  private starting = new Map<string, Promise<AgentSession>>();

  constructor(private opts: HubOptions) {
    this.hiveDb = resolve(opts.hiveDb);
    this.db = new HiveDb(this.hiveDb);
  }

  async add(o: AddOptions): Promise<AgentSession> {
    if (this.sessions.has(o.name) || this.starting.has(o.name)) throw new Error(`agent "${o.name}" already running`);
    const p = this.start(o);
    this.starting.set(o.name, p);
    try {
      return await p;
    } finally {
      this.starting.delete(o.name);
    }
  }

  /** Return the running session called `o.name`, starting it if needed. */
  async ensure(o: AddOptions): Promise<AgentSession> {
    const s = this.sessions.get(o.name);
    if (s && !s.isClosed) return s;
    if (s) this.sessions.delete(o.name);
    const pending = this.starting.get(o.name);
    if (pending) return pending;
    return this.add(o);
  }

  private async start(o: AddOptions): Promise<AgentSession> {
    const { resume, ...rest } = o;
    let resumeSessionId = rest.resumeSessionId;
    if (resume && !resumeSessionId) {
      const prev = this.db.getAgent(o.name);
      const kind = typeof o.agent === "string" ? o.agent : o.agent.id;
      if (prev?.session_id && prev.kind === kind && prev.cwd === resolve(o.cwd)) resumeSessionId = prev.session_id;
    }
    const s = new AgentSession({ ...this.opts.defaults, ...rest, resumeSessionId, hiveDb: this.hiveDb });
    s.on("event", (e) => {
      this.opts.onEvent?.(o.name, e);
      if (e.type === "exit" && this.sessions.get(o.name) === s) this.sessions.delete(o.name);
    });
    await s.start();
    this.sessions.set(o.name, s);
    return s;
  }

  /** Stop an agent. `forget` also removes it from the agents table. */
  async remove(name: string, forget = true) {
    const s = this.sessions.get(name);
    if (s) {
      await s.close();
      this.sessions.delete(name);
    }
    if (forget) this.db.removeAgent(name);
  }

  /** Start the mail delivery loop. */
  run(): void {
    if (this.timer) return;
    const ms = this.opts.pollMs ?? 1500;
    this.timer = setInterval(() => {
      for (const s of this.sessions.values()) void s.poke().catch(() => {});
    }, ms);
    this.timer.unref?.();
  }

  /** Resolve when every agent is idle and no one has unread mail. */
  async settle(timeoutMs = 60_000): Promise<void> {
    const t0 = Date.now();
    for (;;) {
      const live = [...this.sessions.values()].filter((s) => !s.isClosed);
      const busy = live.some((s) => s.busyNow || s.queued > 0);
      const mail = live.some((s) => this.db.unreadCount(s.name) > 0);
      if (!busy && !mail) return;
      if (Date.now() - t0 > timeoutMs) throw new Error("settle timeout");
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.all([...this.sessions.values()].map((s) => s.close()));
    this.sessions.clear();
    this.db.close();
  }
}
