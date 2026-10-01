/**
 * Recipes: a named team of agents + groups + automatic triggers for one
 * workflow, set up in one step (`hive recipe apply <id>` or the UI).
 *
 * Agents marked `alt` use the alternate vendor (e.g. a Codex reviewer for a
 * Claude coder): a second model catches different mistakes.
 */
import type { HiveDb, JobKind } from "../hive/db.js";
import type { PermissionPolicy } from "./session.js";
import { ROLES } from "./roles.js";
import { BB_PREFIX, BRANCHES } from "./watch.js";
import { CREATOR_RECIPES } from "./creator-recipes.js";

export interface RecipeAgent {
  name: string;
  preset?: string;
  role?: string;
  policy?: PermissionPolicy;
  worktree?: boolean;
  briefing?: string;
  /** Use the alternate vendor for this agent. */
  alt?: boolean;
  /** You talk to it (opens a pane in the UI). */
  interactive?: boolean;
}

export interface RecipeJob {
  agent: string;
  kind: JobKind;
  prompt: string;
  every_ms?: number;
  watch_path?: string;
  watch_min_lines?: number;
  cooldown_ms?: number;
  remaining?: number;
}

export interface Recipe {
  id: string;
  label: string;
  description: string;
  agents: RecipeAgent[];
  groups: { name: string; members: string[] }[];
  jobs: RecipeJob[];
  next: string;
  /** Extra project settings the recipe needs (e.g. twitch-clips turns on Twitch polling). */
  setup?: (db: HiveDb) => void;
}

const MIN = 60_000;
const branchOwner = "The agent that owns branch hive/<name> is <name>.";

export const RECIPES: Record<string, Recipe> = {
  "review-loop": {
    id: "review-loop",
    label: "Coder + reviewer",
    description:
      "A coder you talk to works in its own worktree. A reviewer (other vendor) reviews new commits when 40+ lines land or 20 minutes after any change, at most every 5 minutes, and sends findings straight to the coder.",
    agents: [
      { name: "coder", preset: "coder", interactive: true },
      { name: "reviewer", preset: "reviewer", alt: true },
    ],
    groups: [{ name: "dev", members: ["coder", "reviewer", "owner"] }],
    jobs: [
      {
        agent: "reviewer",
        kind: "watch",
        watch_path: BRANCHES,
        watch_min_lines: 40,
        every_ms: 20 * MIN,
        cooldown_ms: 5 * MIN,
        prompt: `Review the new commits listed above. ${branchOwner} Send that agent concrete findings (file:line, why, suggested fix), most severe first; keep it short and say "LGTM" when it's fine. Anything the human must decide goes on the blackboard under review/<slug>.`,
      },
    ],
    next: "Talk to the coder (hive chat <agent> --name coder, or its pane). Keep hive serve or the UI open so reviews run.",
  },

  "solid-code": {
    id: "solid-code",
    label: "Coder + tester + improver",
    description:
      "Every batch of commits gets tested (tests, types, lint) in a separate worktree and failures go back to the coder. An improver compares new code with the codebase (duplication, simpler approaches, missing tests) after 200+ lines, at most hourly.",
    agents: [
      { name: "coder", preset: "coder", interactive: true },
      {
        name: "tester",
        role: "tester",
        policy: "allow-all",
        worktree: true,
        alt: true,
        briefing:
          "You verify other agents' work in your own worktree (a scratch copy). Never commit or push. Check out the branch you're given detached, run the project's own test, type-check and lint commands (read package.json / Makefile / pyproject to find them), and report precisely.",
      },
      {
        name: "improver",
        role: "code improver",
        policy: "allow-reads",
        alt: true,
        briefing:
          "You suggest improvements to new code; you don't edit files. Look for duplicated logic that already exists elsewhere, simpler or more idiomatic approaches, missing tests for edge cases, unclear names, and risky error handling. Be concrete and brief; skip style nits a formatter would fix.",
      },
    ],
    groups: [{ name: "dev", members: ["coder", "tester", "improver", "owner"] }],
    jobs: [
      {
        agent: "tester",
        kind: "watch",
        watch_path: BRANCHES,
        watch_min_lines: 1,
        cooldown_ms: 3 * MIN,
        prompt: `For each branch listed above: in your worktree run \`git checkout --detach <branch>\`, then the project's test suite, type-checker and linter. ${branchOwner} If anything fails, send that agent the failing command and the trimmed error output. If all pass, set blackboard key tests/<branch> to "green @ <short sha>".`,
      },
      {
        agent: "improver",
        kind: "watch",
        watch_path: BRANCHES,
        watch_min_lines: 200,
        every_ms: 2 * 60 * MIN,
        cooldown_ms: 60 * MIN,
        prompt: `Read the new commits listed above with hive_diff and compare them with the rest of the codebase. ${branchOwner} Send that agent the top 3 improvements (file:line, what, a short sketch). If nothing is worth changing, say so in one line.`,
      },
    ],
    next: "Talk to the coder. Test results and suggestions arrive as mail in its pane. Keep hive serve or the UI open.",
  },

  "idea-pipeline": {
    id: "idea-pipeline",
    label: "Brainstorm → polished ideas",
    description:
      "A scout brainstorms raw ideas every 30 minutes (blackboard ideas/raw/). A polisher turns each new raw idea into a ready brief (ideas/ready/) and mails you a digest — at most every 15 minutes.",
    agents: [
      { name: "scout", preset: "scout" },
      {
        name: "polisher",
        role: "idea polisher",
        policy: "allow-reads",
        alt: true,
        briefing:
          "You turn rough ideas into briefs the human can act on. Be skeptical: merge duplicates, drop ideas that don't survive scrutiny (say why), and keep briefs short.",
      },
    ],
    groups: [{ name: "ideas", members: ["scout", "polisher", "owner"] }],
    jobs: [
      {
        agent: "scout",
        kind: "interval",
        every_ms: 30 * MIN,
        prompt:
          "Brainstorm 2-3 new, concrete ideas for this project (features, fixes, automations, content). Check hive_bb_list('ideas/') first to avoid repeats. Write each to the blackboard as ideas/raw/<slug>: one paragraph with the problem, the idea and the files involved.",
      },
      {
        agent: "polisher",
        kind: "watch",
        watch_path: BB_PREFIX + "ideas/raw/",
        watch_min_lines: 1,
        cooldown_ms: 15 * MIN,
        prompt:
          "For each new raw idea listed above: write a brief to ideas/ready/<slug> with Problem, Who benefits, Proposal, Smallest first step, Risks, Effort (S/M/L) — or reject it with one line of reasoning. Delete the raw key afterwards (hive_bb_delete). Then hive_send owner a short digest: what's ready, what you rejected.",
      },
    ],
    next: "Keep hive serve or the UI open. Read results with hive inbox, hive bb ideas/ready/, or the ✉ Hive drawer.",
  },

  squad: {
    id: "squad",
    label: "Squad: planner, coder, reviewer, tester",
    description:
      "Four agents with fixed roles, linked in one group: a planner who breaks your goal into tasks and hands them to the coder, a coder in its own worktree, a reviewer (other vendor) and a tester (other vendor, own worktree) who check every batch of commits automatically.",
    agents: [
      {
        name: "planner",
        role: "planner / tech lead",
        policy: "allow-reads",
        interactive: true,
        briefing:
          "You are the tech lead. Turn the owner's goal into small, testable tasks; keep the plan on the blackboard under plan/<slug>; hand one task at a time to the coder with hive_send (what, where, acceptance criteria); read results with hive_diff and decide what's next. Don't edit files yourself. Tell the owner when a milestone is done or a decision is needed.",
      },
      { name: "coder", preset: "coder", interactive: true },
      { name: "reviewer", preset: "reviewer", alt: true, interactive: true },
      {
        name: "tester",
        role: "tester",
        policy: "allow-all",
        worktree: true,
        alt: true,
        interactive: true,
        briefing:
          "You verify other agents' work in your own worktree (a scratch copy). Never commit or push. Check out the branch you're given detached, run the project's own test, type-check and lint commands, and report precisely: the failing command and trimmed output, or 'green'.",
      },
    ],
    groups: [{ name: "squad", members: ["planner", "coder", "reviewer", "tester", "owner"] }],
    jobs: [
      {
        agent: "reviewer",
        kind: "watch",
        watch_path: BRANCHES,
        watch_min_lines: 40,
        every_ms: 20 * MIN,
        cooldown_ms: 5 * MIN,
        prompt: `Review the new commits listed above. ${branchOwner} Send that agent concrete findings (file:line, why, suggested fix), most severe first; say "LGTM" when it's fine.`,
      },
      {
        agent: "tester",
        kind: "watch",
        watch_path: BRANCHES,
        watch_min_lines: 1,
        cooldown_ms: 3 * MIN,
        prompt: `For each branch listed above: in your worktree run \`git checkout --detach <branch>\`, then the project's test suite, type-checker and linter. ${branchOwner} If anything fails, send that agent the failing command and trimmed output; if all pass, tell the planner "green @ <short sha>".`,
      },
    ],
    next: "Tell the planner what you want built. It hands tasks to the coder; reviewer and tester check each batch of commits on their own.",
  },

  studio: {
    id: "studio",
    label: "Creator studio (chat + skills)",
    description:
      "A chat agent for creative work (titles, descriptions, chapters, hooks) in a content folder. It asks before touching files or paid APIs (voice-overs with ElevenLabs, thumbnail drafts with an image API, when those keys are set). Use skills (hive skill run yt-titles …) for repeatable tasks.",
    agents: [
      {
        name: "studio",
        role: "creative assistant for a YouTube creator",
        policy: "ask",
        interactive: true,
        briefing:
          "You help a YouTube creator with titles, descriptions, chapters, hooks, thumbnail text and scripts. Match the creator's voice and advice when given; prefer specific, curiosity-driven, honest wording over clickbait. Give options, not essays. If the hive_tts / hive_image / hive_image_edit tools are available you can draft voice-overs and thumbnails (saved under out/media/); each call costs money, so only use them when asked.",
      },
    ],
    groups: [],
    jobs: [],
    next: "Talk to studio (its pane, or hive chat <agent> --name studio). Run skills: hive skill list.",
  },
  // ---- creator ----
  ...CREATOR_RECIPES,
};

export interface ApplyResult {
  agents: { name: string; kind: string; interactive: boolean; worktree: boolean; preset?: string; policy: string; role: string }[];
  groups: string[];
  jobs: number[];
}

/**
 * Register a recipe's agents, groups and jobs in the hive. Agents start when
 * a job needs them (hive serve / UI) or when you open them.
 */
export function applyRecipe(db: HiveDb, r: Recipe, o: { cwd: string; kind: string; alt?: string; prefix?: string }): ApplyResult {
  const name = (n: string) => (n === "owner" ? n : `${o.prefix ?? ""}${n}`);
  const out: ApplyResult = { agents: [], groups: [], jobs: [] };
  for (const a of r.agents) {
    const preset = a.preset ? ROLES[a.preset] : undefined;
    const kind = a.alt ? (o.alt ?? o.kind) : o.kind;
    const policy = a.policy ?? preset?.policy ?? "allow-reads";
    const role = a.role ?? preset?.role ?? "";
    const n = name(a.name);
    const prev = db.getAgent(n);
    if (!prev?.kind)
      db.upsertAgent({ name: n, kind, cwd: o.cwd, role, status: "asleep", status_note: `from recipe ${r.id}`, session_id: null });
    db.setAgentConfig(n, policy, a.preset ?? null, a.briefing ?? preset?.briefing ?? null);
    out.agents.push({ name: n, kind: prev?.kind || kind, interactive: !!a.interactive, worktree: !!(a.worktree ?? preset?.worktree), preset: a.preset, policy, role });
  }
  for (const g of r.groups) {
    db.addToGroup(name(g.name), g.members.map(name));
    out.groups.push(name(g.name));
  }
  for (const j of r.jobs) {
    const a = r.agents.find((x) => x.name === j.agent)!;
    const agent = out.agents.find((x) => x.name === name(j.agent))!;
    const preset = a.preset ? ROLES[a.preset] : undefined;
    // Don't duplicate a recipe job that's already active on this agent.
    if (db.listJobs(false).some((x) => x.agent === agent.name && x.prompt === j.prompt)) continue;
    out.jobs.push(
      db.addJob({
        agent: agent.name,
        agent_kind: agent.kind,
        cwd: o.cwd,
        prompt: j.prompt,
        kind: j.kind,
        policy: agent.policy,
        role: agent.role,
        briefing: a.briefing ?? preset?.briefing ?? "",
        worktree: agent.worktree ? 1 : 0,
        every_ms: j.every_ms ?? null,
        watch_path: j.watch_path ?? null,
        watch_min_lines: j.watch_min_lines ?? null,
        cooldown_ms: j.cooldown_ms ?? null,
        remaining: j.remaining ?? null,
      }),
    );
  }
  r.setup?.(db);
  return out;
}

/** Briefing for a recipe agent (used when opening it interactively). */
export function recipeBriefing(agentName: string): string | undefined {
  for (const r of Object.values(RECIPES)) for (const a of r.agents) if (a.name === agentName && a.briefing) return a.briefing;
  return undefined;
}
