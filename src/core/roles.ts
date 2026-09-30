/**
 * Role presets: a policy, a briefing, whether to use a worktree, and an
 * optional default job. They encode the owner's canonical setups:
 * a coder you talk to, a reviewer, a security watcher that rescans when enough
 * lines land, a feature scout every 10 minutes, and an overnight bug hunter.
 */
import type { PermissionPolicy } from "./session.js";
import type { JobKind } from "../hive/db.js";

export interface RolePreset {
  id: string;
  label: string;
  role: string;
  policy: PermissionPolicy;
  worktree: boolean;
  briefing: string;
  job?: { kind: JobKind; prompt: string; every_ms?: number; watch_min_lines?: number; remaining?: number };
}

export const ROLES: Record<string, RolePreset> = {
  coder: {
    id: "coder",
    label: "Coder (you talk to it)",
    role: "coder",
    policy: "ask",
    worktree: true,
    briefing:
      "You are a coding agent working in your own git worktree on branch hive/<your name>. Commit in small, working steps with clear messages. When you finish something reviewable, hive_send a short summary (what changed, how to test) to a reviewer agent if one exists.",
  },
  reviewer: {
    id: "reviewer",
    label: "Reviewer",
    role: "code reviewer",
    policy: "allow-reads",
    worktree: false,
    briefing:
      "You review code. Do not edit files. When another agent sends you work, read the diff (git diff / git log on their hive/<name> branch), then reply with hive_send: concrete findings ordered by severity, each with file:line and a suggested fix. Say plainly when it looks good.",
  },
  security: {
    id: "security",
    label: "Security watcher",
    role: "security reviewer",
    policy: "allow-reads",
    worktree: false,
    briefing:
      "You are a security reviewer. Do not edit files. Look for injection, path traversal, authz gaps, secrets in code, unsafe deserialization, SSRF, command execution and dependency risks. Report real, exploitable issues with file:line and a fix; skip style nits. Post findings to the relevant agent with hive_send and keep a running list on the blackboard under 'security/<slug>'.",
    job: {
      kind: "watch",
      watch_min_lines: 50,
      prompt: "Review the changed lines listed above for security problems. Report only real issues.",
    },
  },
  scout: {
    id: "scout",
    label: "Feature scout",
    role: "feature scout",
    policy: "allow-reads",
    worktree: false,
    briefing:
      "You look for improvements: missing features, rough edges, confusing UX, dead code, missing tests. Do not edit files. Write each idea once to the blackboard as 'ideas/<slug>' (check hive_bb_list('ideas/') first to avoid duplicates) with a one-paragraph rationale and the files involved.",
    job: {
      kind: "interval",
      every_ms: 10 * 60_000,
      prompt: "Find one or two new, concrete improvement ideas for this project that aren't on the blackboard yet.",
    },
  },
  bughunter: {
    id: "bughunter",
    label: "Bug hunter (loop, trusted, own worktree)",
    role: "bug hunter",
    policy: "allow-all",
    worktree: true,
    briefing:
      "You hunt bugs in your own git worktree. Each run: pick one likely bug (from the notes file first), reproduce it with a test, fix it, run the test suite, commit. Never push. Record what you checked in the notes file so the next run doesn't repeat it.",
    job: {
      kind: "loop",
      remaining: 5,
      prompt: "Find and fix one real bug. Add a regression test. Commit when the suite passes.",
    },
  },
};
