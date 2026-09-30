/**
 * Scheduler: runs the jobs table against hub agents.
 *
 *   once      run at next_run, then end
 *   loop      run back to back; stop when `remaining` hits 0 or `until_ts` passes
 *   interval  run every `every_ms` (missed slots are skipped, not replayed)
 *   watch     run when ≥ watch_min_lines changed under watch_path since the last
 *             run (or, with every_ms, when any change is older than every_ms)
 *
 * Each run is a fresh ACP session when `fresh_session` is set (the default),
 * and the prompt points the agent at a persistent notes file so iterations
 * hand over to each other instead of sharing one ever-growing context.
 *
 * Jobs are claimed with a lease in SQLite, so a `hive serve` daemon and a
 * foreground `hive loop` never run the same job. Nothing listens on a socket:
 * other processes add or stop jobs by writing the table.
 */
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { FSWatcher } from "chokidar";
import type { Hub } from "./hub.js";
import type { AgentSession, PermissionPolicy, TurnResult } from "./session.js";
import type { JobRow } from "../hive/db.js";
import { ChangeCounter, describeDiff, watchTree, type DiffStat } from "./watch.js";
import { selfIgnoreHiveDir } from "./worktree.js";

export interface SchedulerOptions {
  hub: Hub;
  tickMs?: number;
  /** Only run these job ids (foreground `hive loop`); default: every enabled job. */
  jobIds?: number[];
  /** Lease owner id; defaults to host pid + random. */
  owner?: string;
  leaseMs?: number;
  /** Debounce for file-change bursts before recounting lines. */
  watchDebounceMs?: number;
  /** Back-off after a failed run. */
  retryMs?: number;
  /** Consecutive failures before a job is ended as 'failed'. */
  maxFailures?: number;
  /** Close agents the scheduler started once none of their jobs remain. */
  closeIdleAgents?: boolean;
  onJob?: (e: JobEvent) => void;
}

export type JobEvent =
  | { type: "run_start"; job: JobRow; iteration: number; sessionId?: string }
  | { type: "run_end"; job: JobRow; iteration: number; result: TurnResult }
  | { type: "job_end"; job: JobRow; reason: string }
  | { type: "watch"; job: JobRow; lines: number; fired: boolean }
  | { type: "error"; job: JobRow; error: string };

interface WatchState {
  counter: ChangeCounter;
  watcher: FSWatcher;
  baseline?: string;
  pending?: { tree: string; diff: DiffStat };
  firstChangeAt?: number;
  checking?: Promise<void>;
  again?: boolean;
}

interface WatchFire {
  text: string;
  tree: string;
  /** Consume the pending change set once the run really starts. */
  commit: () => void;
}

const MAX_ERROR = 500;

export class Scheduler {
  readonly owner: string;
  private timer?: NodeJS.Timeout;
  private running = new Map<number, AgentSession | null>();
  private watches = new Map<number, WatchState>();
  private startedAgents = new Set<string>();
  private ticking = false;
  private stopped = false;

  constructor(private opts: SchedulerOptions) {
    this.owner = opts.owner ?? `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private get db() {
    return this.opts.hub.db;
  }

  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs ?? 1000);
    void this.tick();
  }

  /** Stop scheduling, close watchers, release leases. In-flight turns finish. */
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const w of this.watches.values()) await w.watcher.close();
    this.watches.clear();
    if (this.db.db.open) this.db.releaseJobs(this.owner);
  }

  /** True while any of `ids` (default: all known) is still enabled or running. */
  active(ids = this.opts.jobIds): boolean {
    if (this.running.size) return true;
    const jobs = ids ? ids.map((id) => this.db.getJob(id)).filter(Boolean) : this.db.listJobs(false);
    return jobs.some((j) => j!.enabled);
  }

  /** Resolve once every job this scheduler is responsible for has ended. */
  async idle(pollMs = 250): Promise<void> {
    while (this.active()) await new Promise((r) => setTimeout(r, pollMs));
  }

  async tick() {
    if (this.ticking || this.stopped || !this.db.db.open) return;
    this.ticking = true;
    try {
      const jobs = this.db.claimJobs(this.owner, this.opts.leaseMs ?? 30_000, this.opts.jobIds);
      const live = new Set(jobs.map((j) => j.id));
      // Jobs stopped (or claimed away) while we were watching or running them.
      for (const [id, w] of this.watches) {
        if (!live.has(id)) {
          await w.watcher.close();
          this.watches.delete(id);
        }
      }
      for (const [id, s] of this.running) {
        if (s && !live.has(id) && this.db.getJob(id)?.enabled === 0) void s.cancel().catch(() => {});
      }
      const now = Date.now();
      for (const job of jobs) {
        if (this.running.has(job.id)) continue;
        if (job.until_ts != null && now >= job.until_ts) {
          this.end(job, "until");
          continue;
        }
        if (job.kind === "loop" && job.remaining != null && job.remaining <= 0) {
          this.end(job, "done");
          continue;
        }
        if (job.kind === "watch") {
          const extra = await this.watchReady(job);
          if (extra) this.launch(job, extra);
          continue;
        }
        if (job.next_run <= now) this.launch(job);
      }
      if (this.opts.closeIdleAgents) await this.closeIdleAgents(jobs);
    } catch (e: any) {
      if (!this.stopped) console.error(`[scheduler] tick failed: ${e?.stack ?? e}`);
    } finally {
      this.ticking = false;
    }
  }

  // ---- running ----

  /** Mark the job running synchronously, so the next tick can't start it twice. */
  private launch(job: JobRow, extra?: WatchFire) {
    this.running.set(job.id, null);
    void this.run(job, extra).finally(() => this.running.delete(job.id));
  }

  private async run(job: JobRow, extra?: WatchFire) {
    const hub = this.opts.hub;
    let session: AgentSession;
    try {
      const existed = hub.sessions.has(job.agent);
      session = await hub.ensure({
        name: job.agent,
        agent: job.agent_kind,
        cwd: job.cwd,
        role: job.role,
        policy: job.policy as PermissionPolicy,
        briefing: job.briefing || undefined,
        worktree: !!job.worktree,
      });
      if (!existed) this.startedAgents.add(job.agent);
    } catch (e: any) {
      return this.fail(job, `could not start agent ${job.agent}: ${e?.message ?? e}`);
    }
    // Someone is talking to this agent (or mail is being delivered): try next tick.
    if (session.busyNow) return;
    this.running.set(job.id, session);
    extra?.commit();
    const iteration = job.runs + 1;
    let runId: number | undefined;
    try {
      if (job.fresh_session && !session.pristine) await session.newSession();
      runId = this.db.startRun(job.id, iteration, session.sessionId ?? null);
      this.opts.onJob?.({ type: "run_start", job, iteration, sessionId: session.sessionId });
      const result = await session.runOnce(this.buildPrompt(job, iteration, extra?.text));
      this.db.endRun(runId, result);
      this.opts.onJob?.({ type: "run_end", job, iteration, result });
      if (result.error && result.stopReason === "error") throw new Error(result.error);
      this.afterRun(job, iteration, extra?.tree);
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, MAX_ERROR);
      if (runId != null) this.db.endRun(runId, { stopReason: "error", error: msg });
      this.fail(job, msg, iteration);
    }
  }

  private afterRun(job: JobRow, iteration: number, tree?: string) {
    const cur = this.db.getJob(job.id);
    if (!cur) return;
    const now = Date.now();
    const patch: Partial<JobRow> = { runs: iteration, last_run: now, failures: 0, last_error: null };
    let end: string | undefined;
    switch (job.kind) {
      case "once":
        end = "done";
        break;
      case "loop":
        if (cur.remaining != null) {
          patch.remaining = cur.remaining - 1;
          if (patch.remaining <= 0) end = "done";
        }
        patch.next_run = now;
        break;
      case "interval": {
        const every = Math.max(1000, cur.every_ms ?? 60_000);
        let next = cur.next_run + every;
        while (next <= now) next += every; // skip missed slots
        patch.next_run = next;
        break;
      }
      case "watch":
        if (tree) patch.watch_ref = tree;
        break;
    }
    if (cur.until_ts != null && now >= cur.until_ts) end ??= "until";
    this.db.updateJob(job.id, patch);
    if (end && cur.enabled) this.end({ ...cur, ...patch }, end);
  }

  private fail(job: JobRow, error: string, iteration?: number) {
    const cur = this.db.getJob(job.id) ?? job;
    const failures = cur.failures + 1;
    this.opts.onJob?.({ type: "error", job: cur, error });
    const patch: Partial<JobRow> = {
      failures,
      last_error: error,
      next_run: Date.now() + (this.opts.retryMs ?? 30_000) * Math.min(failures, 10),
    };
    // A failed loop iteration still counts, so a broken job can't spin forever.
    if (iteration != null) {
      patch.runs = iteration;
      patch.last_run = Date.now();
      if (cur.kind === "loop" && cur.remaining != null) patch.remaining = cur.remaining - 1;
    }
    this.db.updateJob(job.id, patch);
    if (failures >= (this.opts.maxFailures ?? 5)) this.end({ ...cur, ...patch }, "failed");
    else if (cur.kind === "once" && iteration != null) this.end({ ...cur, ...patch }, "failed");
    else if (patch.remaining != null && patch.remaining <= 0) this.end({ ...cur, ...patch }, "done");
  }

  private end(job: JobRow, reason: string) {
    this.db.endJob(job.id, reason);
    const w = this.watches.get(job.id);
    if (w) {
      void w.watcher.close();
      this.watches.delete(job.id);
    }
    this.opts.onJob?.({ type: "job_end", job, reason });
  }

  /** Path of the notes file a job's iterations share. */
  notesPath(job: JobRow): string {
    return join(resolve(job.cwd), ".hive", "notes", `job-${job.id}.md`);
  }

  private buildPrompt(job: JobRow, iteration: number, extra?: string): string {
    const parts: string[] = [];
    const schedule =
      job.kind === "loop"
        ? job.remaining != null
          ? `iteration ${iteration} of ${iteration - 1 + job.remaining}`
          : `iteration ${iteration}`
        : job.kind === "interval"
          ? `scheduled run ${iteration}`
          : job.kind === "watch"
            ? `file-change run ${iteration}`
            : "one-off run";
    const until = job.until_ts ? `, until ${new Date(job.until_ts).toISOString()}` : "";
    parts.push(`[hive job #${job.id}, ${job.kind}: ${schedule}${until}]`);
    if (job.fresh_session && job.kind !== "once") {
      const notes = this.notesPath(job);
      if (!existsSync(notes)) {
        selfIgnoreHiveDir(dirname(dirname(notes)));
        mkdirSync(dirname(notes), { recursive: true });
        writeFileSync(
          notes,
          `# Notes for hive job #${job.id} (${job.kind})\n\nTask: ${job.prompt}\n\n## Done / found so far\n\n## Next\n`,
        );
      }
      parts.push(
        `Read and update ${notes} first; it holds what previous iterations found and what's left. ` +
          `This run starts with no memory of earlier ones, so before you finish, record what you did, what you found and what the next iteration should do.`,
      );
    }
    if (extra) parts.push(extra);
    parts.push(job.prompt);
    return parts.join("\n\n");
  }

  // ---- watch jobs ----

  /** Returns prompt context + new tree when a watch job should fire now. */
  private async watchReady(job: JobRow): Promise<WatchFire | undefined> {
    let w = this.watches.get(job.id);
    if (!w) {
      w = await this.startWatch(job);
      if (!w) return undefined;
    }
    if (!w.pending && job.every_ms && w.firstChangeAt && Date.now() - w.firstChangeAt >= job.every_ms) {
      await this.recount(job.id, true);
    }
    const p = w.pending;
    if (!p) return undefined;
    const path = relative(resolve(job.cwd), resolve(job.watch_path!)) || ".";
    return {
      tree: p.tree,
      commit: () => {
        const newer = w.pending !== p;
        w.pending = undefined;
        w.firstChangeAt = undefined;
        w.baseline = p.tree;
        if (newer) void this.recount(job.id);
      },
      text: `Files changed under ${path} since the last review — ${describeDiff(p.diff)}\nFocus on these changes.`,
    };
  }

  private async startWatch(job: JobRow): Promise<WatchState | undefined> {
    if (!job.watch_path) {
      this.end(job, "failed");
      return undefined;
    }
    const gitDir = join(dirname(this.opts.hub.hiveDb), "watch", `job-${job.id}.git`);
    const counter = new ChangeCounter(job.watch_path, gitDir);
    try {
      let baseline = job.watch_ref ?? undefined;
      if (!baseline || !(await counter.has(baseline))) {
        baseline = await counter.snapshot();
        this.db.updateJob(job.id, { watch_ref: baseline });
      }
      const watcher = watchTree(job.watch_path, () => void this.recount(job.id), this.opts.watchDebounceMs ?? 500);
      const w: WatchState = { counter, watcher, baseline };
      this.watches.set(job.id, w);
      // Count what changed while no scheduler was watching.
      if (job.watch_ref) void this.recount(job.id);
      return w;
    } catch (e: any) {
      this.fail(job, `watch setup failed: ${e?.message ?? e}`);
      return undefined;
    }
  }

  /** Recount changed lines for a watch job (serialized per job). */
  private async recount(id: number, force = false): Promise<void> {
    const w = this.watches.get(id);
    if (!w) return;
    if (w.checking) {
      w.again = true;
      return w.checking;
    }
    w.checking = (async () => {
      try {
        do {
          w.again = false;
          const job = this.db.getJob(id);
          if (!job?.enabled || !w.baseline) return;
          const tree = await w.counter.snapshot();
          const diff = await w.counter.diff(w.baseline, tree);
          if (diff.lines > 0) w.firstChangeAt ??= Date.now();
          const min = job.watch_min_lines ?? 50;
          const fire = diff.lines >= min || (force && diff.lines > 0);
          if (fire) w.pending = { tree, diff };
          this.opts.onJob?.({ type: "watch", job, lines: diff.lines, fired: fire });
        } while (w.again);
      } catch (e: any) {
        const job = this.db.getJob(id);
        if (job) this.opts.onJob?.({ type: "error", job, error: `recount: ${e?.message ?? e}` });
      } finally {
        w.checking = undefined;
      }
    })();
    return w.checking;
  }

  private async closeIdleAgents(live: JobRow[]) {
    const wanted = new Set(live.map((j) => j.agent));
    for (const name of this.startedAgents) {
      if (wanted.has(name)) continue;
      const s = this.opts.hub.sessions.get(name);
      if (s && !s.busyNow) {
        this.startedAgents.delete(name);
        await this.opts.hub.remove(name, false);
      }
    }
  }
}

/** "90s", "10m", "1h30m", "2d", "500ms" → ms. */
export function parseDuration(s: string): number {
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/gy;
  const unit: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const str = s.trim().toLowerCase();
  let total = 0;
  let pos = 0;
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(str))) {
    total += Number(m[1]) * unit[m[2]];
    pos = re.lastIndex;
  }
  if (!str || pos !== str.length || total <= 0) throw new Error(`bad duration "${s}" (use e.g. 30s, 10m, 1h30m, 2d)`);
  return Math.round(total);
}

/** 600000 → "10m". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const parts: string[] = [];
  const units: [string, number][] = [
    ["d", 86_400_000],
    ["h", 3_600_000],
    ["m", 60_000],
    ["s", 1000],
  ];
  let rest = Math.round(ms / 1000) * 1000;
  for (const [u, n] of units) {
    if (rest >= n) {
      parts.push(`${Math.floor(rest / n)}${u}`);
      rest %= n;
    }
  }
  return parts.join("");
}

/** One-line human description of when a job runs. */
export function describeSchedule(j: JobRow): string {
  switch (j.kind) {
    case "loop":
      return (
        [j.remaining != null ? `${j.remaining} left` : "", j.until_ts ? `until ${new Date(j.until_ts).toLocaleString()}` : ""]
          .filter(Boolean)
          .join(", ") || "forever"
      );
    case "interval":
      return `every ${formatDuration(j.every_ms ?? 0)}`;
    case "watch":
      return `${j.watch_path} ≥${j.watch_min_lines ?? 50} lines${j.every_ms ? `, max wait ${formatDuration(j.every_ms)}` : ""}`;
    case "once":
      return new Date(j.next_run).toLocaleString();
  }
}
