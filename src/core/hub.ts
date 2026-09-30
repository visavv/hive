/**
 * Hub: owns every AgentSession in one hive and runs the delivery loop that
 * wakes idle agents when they have unread mail. Later the scheduler and the
 * UI server sit on top of this.
 */
import { AgentSession, type SessionOptions, type SessionEvent } from "./session.js";
import { HiveDb } from "../hive/db.js";
import { resolve } from "node:path";

export interface HubOptions {
  hiveDb: string;
  /** Mail delivery poll interval. */
  pollMs?: number;
  onEvent?: (agent: string, e: SessionEvent) => void;
}

export class Hub {
  readonly sessions = new Map<string, AgentSession>();
  readonly db: HiveDb;
  private timer?: NodeJS.Timeout;
  private hiveDb: string;

  constructor(private opts: HubOptions) {
    this.hiveDb = resolve(opts.hiveDb);
    this.db = new HiveDb(this.hiveDb);
  }

  async add(o: Omit<SessionOptions, "hiveDb">): Promise<AgentSession> {
    if (this.sessions.has(o.name)) throw new Error(`agent "${o.name}" already running`);
    const s = new AgentSession({ ...o, hiveDb: this.hiveDb });
    s.on("event", (e) => this.opts.onEvent?.(o.name, e));
    await s.start();
    this.sessions.set(o.name, s);
    return s;
  }

  async remove(name: string) {
    const s = this.sessions.get(name);
    if (!s) return;
    await s.close();
    this.sessions.delete(name);
    this.db.removeAgent(name);
  }

  /** Start the mail delivery loop. */
  run(): void {
    const ms = this.opts.pollMs ?? 1500;
    this.timer = setInterval(() => {
      for (const s of this.sessions.values()) void s.poke();
    }, ms);
    this.timer.unref?.();
  }

  /** Resolve when every agent is idle and no one has unread mail. */
  async settle(timeoutMs = 60_000): Promise<void> {
    const t0 = Date.now();
    for (;;) {
      const busy = [...this.sessions.values()].some((s) => s.busyNow);
      const mail = [...this.sessions.keys()].some((n) => this.db.unreadCount(n) > 0);
      if (!busy && !mail) return;
      if (Date.now() - t0 > timeoutMs) throw new Error("settle timeout");
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    await Promise.all([...this.sessions.values()].map((s) => s.close()));
    this.sessions.clear();
    this.db.close();
  }
}
