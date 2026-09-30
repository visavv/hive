/**
 * "What happened while I was away": job runs, their outcomes and summaries,
 * new commits on agent branches, blackboard changes, mail to the owner, and
 * agents currently waiting on the human. Shared by `hive report` and the UI.
 */
import type { HiveDb } from "../hive/db.js";
import { listWorktrees } from "./worktree.js";
import { git } from "./worktree.js";

export interface Report {
  since: number;
  jobs: {
    id: number;
    agent: string;
    kind: string;
    prompt: string;
    runs: number;
    ok: number;
    failed: number;
    limited: number;
    tokens: number;
    lastSummary?: string;
    lastError?: string;
  }[];
  commits: { repo: string; branch: string; lines: string[] }[];
  blackboard: { key: string; value: string; by: string; at: number }[];
  ownerMail: { from: string; subject: string; body: string; at: number }[];
  mailCount: number;
  waiting: { agent: string; note: string }[];
}

export async function buildReport(db: HiveDb, since: number, cwds: string[]): Promise<Report> {
  const byJob = new Map<number, Report["jobs"][number]>();
  for (const r of db.runsSince(since)) {
    const j =
      byJob.get(r.job_id) ??
      ({ id: r.job_id, agent: r.agent, kind: r.kind, prompt: r.prompt, runs: 0, ok: 0, failed: 0, limited: 0, tokens: 0 } as Report["jobs"][number]);
    j.runs++;
    if (r.stop_reason === "rate_limited") j.limited++;
    else if (r.error || r.stop_reason === "error") {
      j.failed++;
      j.lastError = r.error ?? undefined;
    } else if (r.ended) j.ok++;
    try {
      j.tokens += r.usage ? (JSON.parse(r.usage).totalTokens ?? 0) : 0;
    } catch {}
    if (r.summary) j.lastSummary = r.summary;
    byJob.set(r.job_id, j);
  }

  const commits: Report["commits"] = [];
  const seen = new Set<string>();
  for (const cwd of cwds) {
    try {
      const { repo, base, worktrees } = await listWorktrees(cwd);
      if (seen.has(repo)) continue;
      seen.add(repo);
      for (const w of worktrees) {
        // Only the agent's own commits, not the base branch's history.
        const out = await git(["log", `--since=${new Date(since).toISOString()}`, "--format=%h %s", `${base}..${w.branch}`], repo).catch(() => "");
        const lines = out.split("\n").filter(Boolean);
        if (lines.length) commits.push({ repo, branch: w.branch, lines });
      }
    } catch {
      // not a git repo
    }
  }

  const msgs = db.messagesSince(since);
  return {
    since,
    jobs: [...byJob.values()],
    commits,
    blackboard: db.bbSince(since).map((e) => ({ key: e.key, value: e.value, by: e.updated_by, at: e.updated_at })),
    ownerMail: msgs.filter((m) => m.to_agent === "owner").map((m) => ({ from: m.from_agent, subject: m.subject, body: m.body, at: m.ts })),
    mailCount: msgs.length,
    waiting: db
      .listAgents()
      .filter((a) => a.status === "waiting" || a.status === "error")
      .map((a) => ({ agent: a.name, note: `${a.status}: ${a.status_note}` })),
  };
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/** Plain-text rendering for the terminal. */
export function renderReport(r: Report): string {
  const out: string[] = [];
  out.push(`Since ${new Date(r.since).toLocaleString()}`);
  if (r.waiting.length) {
    out.push("", "NEEDS YOU");
    for (const w of r.waiting) out.push(`  ${w.agent}: ${clip(w.note, 120)}`);
  }
  if (r.ownerMail.length) {
    out.push("", "MAIL TO YOU");
    for (const m of r.ownerMail) out.push(`  ${new Date(m.at).toLocaleTimeString()} ${m.from}: ${m.subject}`, `    ${clip(m.body.replace(/\s+/g, " "), 300)}`);
  }
  out.push("", "JOBS");
  if (!r.jobs.length) out.push("  (no runs)");
  for (const j of r.jobs) {
    const parts = [`${j.ok} ok`, j.failed && `${j.failed} failed`, j.limited && `${j.limited} paused by usage limits`, j.tokens && `${j.tokens.toLocaleString()} tok`].filter(Boolean);
    out.push(`  #${j.id} ${j.kind} on ${j.agent} — ${j.runs} run${j.runs === 1 ? "" : "s"}: ${parts.join(", ")}`);
    out.push(`    task: ${clip(j.prompt.replace(/\s+/g, " "), 100)}`);
    if (j.lastSummary) out.push(`    last: ${clip(j.lastSummary.replace(/\s+/g, " "), 400)}`);
    if (j.lastError) out.push(`    error: ${clip(j.lastError, 200)}`);
  }
  if (r.commits.length) {
    out.push("", "COMMITS ON AGENT BRANCHES");
    for (const c of r.commits) {
      out.push(`  ${c.branch} (${c.lines.length})`);
      for (const l of c.lines.slice(0, 10)) out.push(`    ${l}`);
      if (c.lines.length > 10) out.push(`    … ${c.lines.length - 10} more`);
    }
  }
  if (r.blackboard.length) {
    out.push("", "BLACKBOARD CHANGES");
    for (const b of r.blackboard) out.push(`  ${b.key} (${b.by}): ${clip(b.value.replace(/\s+/g, " "), 160)}`);
  }
  out.push("", `${r.mailCount} hive message${r.mailCount === 1 ? "" : "s"} exchanged.`);
  return out.join("\n");
}
