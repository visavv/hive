/**
 * Hub: owns every AgentSession in one hive and runs the delivery loop that
 * wakes idle agents when they have unread mail. The scheduler and (later) the
 * UI sit on top of this.
 */
import { AgentSession, type SessionOptions, type SessionEvent } from "./session.js";
import { HiveDb } from "../hive/db.js";
import { dirname, join, resolve } from "node:path";
import { ensureWorktree } from "./worktree.js";
import { AGENTS, killGroup } from "./agents.js";
import { ROLES } from "./roles.js";
import { checkAutomatic, notifyOnce } from "./budget.js";
import { agentNameProblem } from "./names.js";
import { hiveHome } from "./home.js";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { mediaKinds, runMedia } from "../hive/media.js";

export interface HubOptions {
  hiveDb: string;
  /** Mail delivery poll interval. */
  pollMs?: number;
  onEvent?: (agent: string, e: SessionEvent) => void;
  /**
   * Start agents that aren't running anywhere but have unread mail (resuming
   * their session), and stop them again once idle. For `hive serve` and the UI,
   * so hand-offs between agents work overnight.
   */
  wakeSleeping?: boolean;
  /** Lease owner id (default: pid + random). */
  id?: string;
  /** Defaults applied to every add() (e.g. the CLI's permission/elicitation prompts). */
  defaults?: Partial<Pick<SessionOptions, "askPermission" | "elicit" | "briefing" | "startTimeoutMs">>;
}

export type AddOptions = Omit<SessionOptions, "hiveDb"> & {
  /**
   * Resume this agent's previous ACP session (stored in the agents table) if
   * it was the same vendor in the same cwd and the vendor supports it.
   */
  resume?: boolean;
  /** Run in its own git worktree on branch hive/<name> (created if missing). */
  worktree?: boolean;
  /** Role preset id, remembered so the agent can be restarted the same way. */
  preset?: string;
};

/** The agent is running in another hive process (CLI chat, serve, UI). */
export class AgentElsewhereError extends Error {
  constructor(
    readonly agent: string,
    readonly owner: string,
  ) {
    super(`agent "${agent}" is already running in another hive process (${owner})`);
  }
}

const AGENT_LEASE_MS = 30_000;

export class Hub {
  readonly sessions = new Map<string, AgentSession>();
  readonly db: HiveDb;
  readonly hiveDb: string;
  /** Lease owner id for agents this process runs. */
  readonly id: string;
  private timer?: NodeJS.Timeout;
  private leaseTimer: NodeJS.Timeout;
  private starting = new Map<string, Promise<AgentSession>>();

  constructor(private opts: HubOptions) {
    this.hiveDb = resolve(opts.hiveDb);
    this.db = new HiveDb(this.hiveDb);
    this.id = opts.id ?? `${process.pid}@${Math.random().toString(36).slice(2, 8)}`;
    this.leaseTimer = setInterval(() => {
      if (this.db.db.open) this.db.renewAgents(this.id, [...this.sessions.keys(), ...this.starting.keys()], AGENT_LEASE_MS);
    }, AGENT_LEASE_MS / 3);
    this.leaseTimer.unref?.();
    // Media calls agents request through the db (keys stay in this process).
    if (mediaKinds().length) {
      this.mediaTimer = setInterval(() => void this.mediaTick(), 300);
      this.mediaTimer.unref?.();
    }
  }

  private mediaTimer?: NodeJS.Timeout;
  private mediaBusy = 0;
  private async mediaTick() {
    if (!this.db.db.open || this.mediaBusy >= 2) return;
    const job = this.db.claimMedia(mediaKinds());
    if (!job) return;
    this.mediaBusy++;
    try {
      // The folder is the one this hub knows for the agent, never one from the request.
      const cwd = this.sessions.get(job.agent)?.cwd ?? this.db.getAgent(job.agent)?.cwd;
      if (!cwd) throw new Error(`unknown agent ${job.agent}`);
      const out = await runMedia(this.db, job.agent, cwd, job.kind, JSON.parse(job.params), job.id);
      if (this.db.db.open) this.db.finishMedia(job.id, out, null);
    } catch (e: any) {
      if (this.db.db.open) this.db.finishMedia(job.id, null, String(e?.message ?? e).slice(0, 1000));
    } finally {
      this.mediaBusy--;
    }
  }

  async add(o: AddOptions): Promise<AgentSession> {
    // Names become branch names (hive/<name>), paths and mail addresses.
    const problem = agentNameProblem(o.name);
    if (problem) throw new Error(`invalid agent name "${o.name}": ${problem}`);
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
    // Only one process may run a given agent name, or both would answer its mail.
    const prev = this.db.getAgent(o.name);
    const claim = this.db.claimAgent(o.name, this.id, AGENT_LEASE_MS);
    if (!claim.ok) throw new AgentElsewhereError(o.name, claim.owner);
    // Reclaiming our own agent after a crash (same hub id): its old process
    // tree may still be running — stop it before starting a new one.
    // Only if the lease is recent, so a long-dead pid can't have been reused.
    if (prev?.owner === this.id && prev.pid && (prev.lease_until ?? 0) > Date.now() - 60_000) killGroup(prev.pid, "SIGKILL");
    try {
      return await this.startClaimed(o);
    } catch (e) {
      if (this.db.db.open) {
        // An agent that never existed before this failed start shouldn't linger.
        if (!prev || !prev.kind) this.db.removeAgent(o.name, this.id);
        else this.db.releaseAgent(o.name, this.id);
      }
      throw e;
    }
  }

  private async startClaimed(o: AddOptions): Promise<AgentSession> {
    const { resume, worktree, preset, ...rest } = o;
    // Worktrees live next to the hive db (the per-user project dir by default).
    if (worktree) rest.cwd = (await ensureWorktree(o.cwd, o.name, join(dirname(this.hiveDb), "worktrees"))).path;
    let resumeSessionId = rest.resumeSessionId;
    if (resume && !resumeSessionId) {
      const prev = this.db.getAgent(o.name);
      const kind = typeof o.agent === "string" ? o.agent : o.agent.id;
      if (prev?.session_id && prev.kind === kind && prev.cwd === resolve(rest.cwd)) resumeSessionId = prev.session_id;
    }
    const provider = typeof o.agent === "string" ? o.agent : o.agent.id;
    const s = new AgentSession({
      ...this.opts.defaults,
      mediaKinds: mediaKinds(),
      autoGuard: () => {
        const g = checkAutomatic(this.db, provider);
        if (!g.ok) notifyOnce(this.db, g);
        return g;
      },
      ...rest,
      resumeSessionId,
      hiveDb: this.hiveDb,
    });
    s.on("event", (e) => {
      this.opts.onEvent?.(o.name, e);
      if (e.type === "exit" && this.sessions.get(o.name) === s) {
        this.sessions.delete(o.name);
        if (this.db.db.open) this.db.releaseAgent(o.name, this.id);
      }
    });
    await s.start();
    this.db.setPid(o.name, s.pid ?? null);
    this.db.setAgentConfig(o.name, rest.policy ?? "ask", preset ?? null, rest.briefing ?? null);
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
    if (forget) this.db.removeAgent(name, this.id);
    else this.db.releaseAgent(name, this.id);
  }

  /** Agents this hub started only to deliver their mail. */
  private woken = new Set<string>();
  private lastWakeScan = 0;
  /** Agents whose wake-up failed to start (CLI missing or broken): wait before trying again. */
  private wakeFails = new Map<string, { delay: number; until: number }>();

  private async wakeSleeping() {
    const now = Date.now();
    if (now - this.lastWakeScan < 5000) return;
    this.lastWakeScan = now;
    for (const a of this.db.listAgents()) {
      if (this.sessions.has(a.name) || this.starting.has(a.name) || !a.kind || !AGENTS[a.kind]) continue;
      if (a.owner && (a.lease_until ?? 0) > now) continue; // running elsewhere
      if (!a.cwd || !existsSync(a.cwd) || this.db.unreadCount(a.name) === 0) continue;
      const fail = this.wakeFails.get(a.name);
      if (fail && fail.until > now) continue;
      // The budget holds automatic work: the woken agent couldn't deliver anyway.
      if (!checkAutomatic(this.db, a.kind, now).ok) continue;
      const preset = a.preset ? ROLES[a.preset] : undefined;
      this.woken.add(a.name);
      this.opts.onEvent?.(a.name, { type: "notice", text: `waking ${a.name} to deliver its mail` });
      void this.ensure({
        name: a.name,
        agent: a.kind,
        cwd: a.cwd,
        role: a.role,
        policy: (a.policy as SessionOptions["policy"]) ?? "allow-reads",
        preset: a.preset ?? undefined,
        briefing: a.briefing ?? preset?.briefing,
        resume: true,
        askTimeoutMs: 15 * 60_000,
      }).then(
        () => this.wakeFails.delete(a.name),
        (e) => {
          this.woken.delete(a.name);
          // 30s, doubling up to 30 min, so a missing CLI isn't respawned every few seconds.
          const delay = Math.min(30 * 60_000, fail ? fail.delay * 2 : 30_000);
          this.wakeFails.set(a.name, { delay, until: Date.now() + delay });
          this.opts.onEvent?.(a.name, { type: "notice", text: `couldn't wake ${a.name} (${String(e?.message ?? e).slice(0, 200)}); trying again in ${Math.round(delay / 1000)}s` });
        },
      );
    }
    // Put them back to sleep once their mail is handled.
    for (const name of this.woken) {
      const s = this.sessions.get(name);
      if (!s) {
        this.woken.delete(name);
        continue;
      }
      // Mail the budget holds back doesn't keep it awake.
      const done = this.db.unreadCount(name) === 0 || !checkAutomatic(this.db, this.db.getAgent(name)?.kind ?? "").ok;
      if (!s.busyNow && s.queued === 0 && s.idleMs > 60_000 && done && !this.db.listJobs(false).some((j) => j.agent === name)) {
        this.woken.delete(name);
        await this.remove(name, false);
      }
    }
  }

  /** Start the mail delivery loop. */
  run(): void {
    if (this.timer) return;
    try {
      this.db.prune();
      this.db.failStaleMedia();
      pruneFiles([join(hiveHome(), "api-sessions"), join(hiveHome(), "cache", "youtube")], 30);
    } catch {}
    const ms = this.opts.pollMs ?? 1500;
    this.timer = setInterval(() => {
      for (const s of this.sessions.values()) void s.poke().catch(() => {});
      if (this.opts.wakeSleeping) void this.wakeSleeping().catch(() => {});
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
    clearInterval(this.leaseTimer);
    if (this.mediaTimer) clearInterval(this.mediaTimer);
    this.timer = undefined;
    await Promise.all([...this.sessions.values()].map((s) => s.close()));
    if (this.db.db.open) for (const n of this.sessions.keys()) this.db.releaseAgent(n, this.id);
    this.sessions.clear();
    this.db.close();
  }
}

/** Delete files older than `days` in these folders (API conversations, caption cache). */
function pruneFiles(dirs: string[], days: number) {
  const cutoff = Date.now() - days * 86_400_000;
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      try {
        if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
      } catch {}
    }
  }
}
