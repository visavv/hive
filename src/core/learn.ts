/**
 * "Explain every change": when an agent you're watching finishes a turn that
 * changed files, the teacher agent gets an automatic prompt with a trimmed
 * diff and explains it in plain language.
 *
 * - The folder is snapshotted when the agent's turn starts and compared when
 *   it ends, so files that were already dirty don't count again.
 * - At most one explanation per agent per `minGapMs` (2 minutes): changes in
 *   between are coalesced into the next one.
 * - Delivery is automatic work: the caller checks the budget guard and says
 *   "held" when it may not run now; the watcher then retries later.
 */
import { changedSince, diffOf, snapshotTree, type TreeSnapshot } from "./code.js";

export const EXPLAIN_GAP_MS = 2 * 60_000;
export const EXPLAIN_DIFF_CAP = 8 * 1024;
const RETRY_MS = 5 * 60_000;

export type Delivery = "sent" | "held" | "no-teacher";

export interface ExplainOptions {
  /** Is "explain every change" on for this agent? */
  isOn: (agent: string) => boolean;
  /** The agent's folder (worktree), if it's known. */
  cwdOf: (agent: string) => string | undefined;
  /** Send the prompt to the teacher as automatic work. */
  deliver: (prompt: string, from: string) => Promise<Delivery>;
  minGapMs?: number;
  now?: () => number;
  onError?: (agent: string, e: unknown) => void;
}

interface Pending {
  cwd: string;
  base: string | null;
  files: Set<string>;
  timer?: NodeJS.Timeout;
}

export function explainPrompt(agent: string, files: string[], diff: string): string {
  const list = files.length > 12 ? `${files.slice(0, 12).join(", ")} and ${files.length - 12} more` : files.join(", ");
  return [
    `[hive learn] ${agent} just changed these files: ${list}`,
    "",
    "Explain what changed and why in plain language, for a beginner: what the code does now that it didn't before, and the reason it was probably done this way. Point at the exact lines. Keep it to a few short paragraphs. Add a glossary card only for a genuinely new term.",
    "",
    "```diff",
    diff || "(no text diff: binary, deleted or very large files)",
    "```",
  ].join("\n");
}

export class ExplainWatcher {
  private snaps = new Map<string, Promise<TreeSnapshot | undefined>>();
  private pending = new Map<string, Pending>();
  private lastSent = new Map<string, number>();
  private closed = false;

  constructor(private o: ExplainOptions) {}

  private now() {
    return this.o.now?.() ?? Date.now();
  }

  /** The agent started a turn: remember what its folder looks like. */
  turnStart(agent: string) {
    if (this.closed || !this.o.isOn(agent)) return;
    const cwd = this.o.cwdOf(agent);
    if (!cwd) return;
    this.snaps.set(agent, snapshotTree(cwd).catch(() => undefined));
  }

  /** The agent's turn ended: queue an explanation if it changed files. Resolves when that's decided (tests). */
  async turnEnd(agent: string): Promise<string[]> {
    const snapP = this.snaps.get(agent);
    this.snaps.delete(agent);
    if (this.closed || !snapP || !this.o.isOn(agent)) return [];
    const cwd = this.o.cwdOf(agent);
    const snap = await snapP;
    if (!cwd || !snap) return [];
    let files: string[];
    try {
      files = await changedSince(cwd, snap);
    } catch (e) {
      this.o.onError?.(agent, e);
      return [];
    }
    if (!files.length) return [];
    const p = this.pending.get(agent);
    if (p && p.cwd === cwd) for (const f of files) p.files.add(f);
    else this.pending.set(agent, { cwd, base: snap.head, files: new Set(files), timer: p?.timer });
    await this.schedule(agent);
    return files;
  }

  private async schedule(agent: string) {
    const p = this.pending.get(agent);
    if (!p || p.timer) return;
    const gap = this.o.minGapMs ?? EXPLAIN_GAP_MS;
    const wait = (this.lastSent.get(agent) ?? -Infinity) + gap - this.now();
    if (wait <= 0) return this.flush(agent);
    p.timer = setTimeout(() => {
      p.timer = undefined;
      void this.flush(agent);
    }, wait);
    p.timer.unref?.();
  }

  /** Send what's pending for `agent` now (rate limit already checked). */
  async flush(agent: string) {
    const p = this.pending.get(agent);
    if (!p || this.closed) return;
    if (!this.o.isOn(agent)) {
      this.pending.delete(agent);
      return;
    }
    const files = [...p.files].sort();
    let res: Delivery;
    try {
      const diff = await diffOf(p.cwd, p.base, files, EXPLAIN_DIFF_CAP);
      res = await this.o.deliver(explainPrompt(agent, files, diff), agent);
    } catch (e) {
      this.o.onError?.(agent, e);
      res = "held";
    }
    if (res === "sent" || res === "no-teacher") {
      // No teacher: drop it rather than flood one in later with stale changes.
      this.pending.delete(agent);
      if (res === "sent") this.lastSent.set(agent, this.now());
      return;
    }
    // Held by the budget: keep coalescing, try again later.
    p.timer = setTimeout(() => {
      p.timer = undefined;
      void this.flush(agent);
    }, RETRY_MS);
    p.timer.unref?.();
  }

  /** Pending files per agent (tests, UI). */
  pendingFiles(agent: string): string[] {
    return [...(this.pending.get(agent)?.files ?? [])].sort();
  }

  /** Forget an agent (toggle off, agent removed). */
  drop(agent: string) {
    const p = this.pending.get(agent);
    if (p?.timer) clearTimeout(p.timer);
    this.pending.delete(agent);
    this.snaps.delete(agent);
  }

  close() {
    this.closed = true;
    for (const a of [...this.pending.keys()]) this.drop(a);
  }
}
