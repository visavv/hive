/**
 * Verdict mode: one prompt to several agents at once, then a judge.
 *
 *   1. Contenders (e.g. claude, codex, gemini-api) solve the same task in
 *      parallel. In code mode each works in its own git worktree on branch
 *      hive/v<id>-<n>-<kind>; in text mode they just answer.
 *   2. The judge (pick a strong model) gets every result, labelled blind as
 *      Solution A/B/C, reads the code, finds bugs, scores and compares, and
 *      decides what the final solution takes from each, with a merge plan.
 *   3. Optionally "apply": the agent that wrote the chosen base solution builds
 *      the merged version in its worktree, following the verdict.
 *
 * It costs N+1 agent turns (plus one for apply), so it's a button you press,
 * not something that runs on its own. Runs count toward usage like any turn.
 */
import { join } from "node:path";
import { execFile } from "node:child_process";
import type { Hub } from "./hub.js";
import type { PermissionPolicy } from "./session.js";
import { AGENTS } from "./agents.js";
import { repoRoot } from "./worktree.js";
import { untrusted } from "./trust.js";
import { saveOutput } from "./skills.js";

export type VerdictMode = "code" | "text";

export interface Contender {
  label: string; // "A", "B", … (what the judge sees)
  kind: string;
  agent: string;
  status: "waiting" | "working" | "done" | "failed";
  branch?: string;
  path?: string;
  reply?: string;
  diffStat?: string;
  error?: string;
  ms?: number;
}

export interface VerdictState {
  id: number;
  ts: number;
  prompt: string;
  mode: VerdictMode;
  cwd: string;
  judgeKind: string;
  judgeAgent: string;
  judgeModel?: string;
  status: "running" | "judging" | "done" | "failed" | "applying" | "applied";
  contenders: Contender[];
  verdict?: string;
  base?: string; // label the judge chose as the base
  report?: string; // saved markdown path
  error?: string;
  applied?: { agent: string; reply?: string; error?: string };
}

export interface VerdictOptions {
  prompt: string;
  kinds: string[];
  judge: string;
  judgeModel?: string;
  mode?: VerdictMode;
  cwd: string;
  /** Contenders' permission policy (code mode needs edits; they're in their own worktrees). */
  policy?: PermissionPolicy;
  timeoutMs?: number;
  onProgress?: (s: VerdictState) => void;
}

const MAX_DIFF = 60_000;
const LABELS = "ABCDEFGH";

function sh(args: string[], cwd: string): Promise<string> {
  return new Promise((res, rej) =>
    execFile("git", args, { cwd, maxBuffer: 50_000_000, windowsHide: true }, (e, out, err) => (e ? rej(new Error(String(err || e.message))) : res(String(out)))),
  );
}

function contenderPrompt(prompt: string, mode: VerdictMode): string {
  return mode === "code"
    ? `${prompt}\n\n---\nYou are one of several agents solving this same task independently; a reviewer will compare the solutions and pick the best parts. Work only in your current folder (your own git worktree and branch). Make it work and test it if you can. When done, commit your work with a clear message, then reply with: 1) approach, 2) files changed, 3) how to test it, 4) known limitations. Don't message other agents.`
    : `${prompt}\n\n---\nYou are one of several assistants answering this independently; a reviewer will compare the answers and combine the best parts. Give your best complete answer. Don't message other agents.`;
}

function judgePrompt(s: VerdictState, results: { c: Contender; body: string }[]): string {
  const code = s.mode === "code";
  const parts = results.map(({ c, body }) => `## Solution ${c.label}\n${code && c.path ? `(working copy, read-only for you: ${c.path})\n` : ""}${untrusted(`solution ${c.label}`, body)}`);
  return [
    `You are the judge in a verdict round. ${results.length} agents solved the same task independently. Compare their ${code ? "solutions" : "answers"} critically and decide what the final ${code ? "solution" : "answer"} should take from each.`,
    `# Task\n${s.prompt}`,
    ...parts,
    `# What to do`,
    code
      ? `1. For each solution: does it actually do the task? List bugs with file:line, why it's wrong and severity; missing edge cases; missing or weak tests; security problems; code quality. Read the code in the working copies to verify — don't trust the summaries.`
      : `1. For each answer: correctness, completeness, factual errors, clarity, and how well it fits the task.`,
    `2. Score each ${code ? "solution" : "answer"} 1–5 on correctness, completeness, ${code ? "code quality, tests" : "clarity, originality"} and risk, in a table.`,
    `3. Verdict: the best base and exactly what to take from each of the others (specific functions, files or ideas), what to drop, and why.`,
    code
      ? `4. Merge plan: ordered, concrete steps an agent can follow to build the final version on top of the base solution, including fixes for the bugs you found.`
      : `4. Write the final combined answer under a heading "## Final answer".`,
    `Start your reply with exactly one line "VERDICT: base = Solution X". Be specific and brief; no flattery.`,
  ].join("\n\n");
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<never>((_, rej) => {
      t = setTimeout(() => {
        onTimeout();
        rej(new Error(`timed out after ${Math.round(ms / 60000)} min`));
      }, ms);
    }),
  ]);
}

/** Start a verdict round; resolves when the judge is done (or the round failed). */
export async function runVerdict(hub: Hub, o: VerdictOptions): Promise<VerdictState> {
  const mode = o.mode ?? "code";
  const kinds = o.kinds.filter(Boolean);
  if (kinds.length < 2) throw new Error("pick at least two agents to compare");
  if (kinds.length > LABELS.length) throw new Error(`at most ${LABELS.length} contenders`);
  for (const k of [...kinds, o.judge]) if (!AGENTS[k]) throw new Error(`unknown agent "${k}"`);
  if (!o.prompt.trim()) throw new Error("the prompt is empty");
  let baseSha = "";
  if (mode === "code") {
    try {
      const repo = await repoRoot(o.cwd);
      baseSha = (await sh(["rev-parse", "HEAD"], repo)).trim();
    } catch {
      throw new Error("code mode needs a git repository with at least one commit (or use text mode)");
    }
  }
  const s: VerdictState = {
    id: 0,
    ts: Date.now(),
    prompt: o.prompt.trim(),
    mode,
    cwd: o.cwd,
    judgeKind: o.judge,
    judgeAgent: "",
    judgeModel: o.judgeModel,
    status: "running",
    contenders: [],
  };
  s.id = hub.db.addVerdict(s);
  // Shuffle so "Solution A" isn't always the first vendor you picked (keeps the judge blind).
  const order = kinds.map((k, i) => ({ k, i, r: Math.random() })).sort((a, b) => a.r - b.r);
  s.contenders = order.map(({ k, i }, n) => ({ label: LABELS[n], kind: k, agent: `v${s.id}-${i + 1}-${k}`.slice(0, 40), status: "waiting" }));
  s.judgeAgent = `v${s.id}-judge`;
  const save = () => {
    hub.db.saveVerdict(s.id, s);
    o.onProgress?.(structuredClone(s));
  };
  save();
  const timeout = o.timeoutMs ?? 30 * 60_000;

  await Promise.allSettled(
    s.contenders.map(async (c) => {
      const t0 = Date.now();
      try {
        c.status = "working";
        save();
        const sess = await hub.add({
          name: c.agent,
          agent: c.kind,
          cwd: o.cwd,
          worktree: mode === "code",
          policy: o.policy ?? (mode === "code" ? "allow-all" : "reject-all"),
          role: `verdict #${s.id} contender`,
          resume: false,
        });
        c.path = sess.cwd;
        if (mode === "code") c.branch = `hive/${c.agent}`;
        const r = await withTimeout(sess.runOnce(contenderPrompt(s.prompt, mode), { automatic: false }), timeout, () => void sess.cancel());
        c.reply = sess.lastReply;
        if (r.error) throw new Error(r.error);
        c.status = "done";
      } catch (e: any) {
        c.status = "failed";
        c.error = String(e?.message ?? e).slice(0, 500);
      } finally {
        c.ms = Date.now() - t0;
        save();
      }
    }),
  );

  const done = s.contenders.filter((c) => c.status === "done");
  if (!done.length) {
    s.status = "failed";
    s.error = "no contender finished";
    save();
    await closeAll(hub, s);
    return s;
  }

  // Collect what each produced: the code changes since the start (committed or not) plus the summary.
  const results: { c: Contender; body: string }[] = [];
  for (const c of done) {
    let body = `### Summary from the agent\n${c.reply?.trim() || "(no reply)"}`;
    if (mode === "code" && c.path) {
      try {
        await sh(["add", "-A", "--intent-to-add"], c.path).catch(() => "");
        c.diffStat = (await sh(["diff", "--stat", baseSha], c.path)).trim();
        let diff = await sh(["diff", baseSha], c.path);
        if (diff.length > MAX_DIFF) diff = diff.slice(0, MAX_DIFF) + `\n… (diff cut at ${MAX_DIFF / 1000} KB; read the working copy for the rest)`;
        body += `\n\n### Changes (${c.branch})\n${c.diffStat || "(no changes)"}\n\n${diff || "(empty diff)"}`;
      } catch (e: any) {
        body += `\n\n(could not read the changes: ${e?.message ?? e})`;
      }
    }
    results.push({ c, body });
  }

  s.status = "judging";
  save();
  try {
    const judge = await hub.add({
      name: s.judgeAgent,
      agent: s.judgeKind,
      cwd: o.cwd,
      policy: "allow-reads",
      role: `verdict #${s.id} judge`,
      resume: false,
    });
    if (s.judgeModel && judge.configOptions.some((c) => c.id === "model")) await judge.setConfigOption("model", s.judgeModel).catch(() => {});
    const r = await withTimeout(judge.runOnce(judgePrompt(s, results), { automatic: false }), timeout, () => void judge.cancel());
    if (r.error) throw new Error(r.error);
    s.verdict = judge.lastReply.trim();
    s.base = s.verdict.match(/VERDICT:\s*base\s*=\s*Solution\s+([A-H])/i)?.[1]?.toUpperCase();
    s.status = "done";
  } catch (e: any) {
    s.status = "failed";
    s.error = `judge: ${String(e?.message ?? e).slice(0, 500)}`;
  }
  s.report = writeReport(s);
  save();
  if (s.status === "done") hub.db.send("hive", "owner", `verdict #${s.id} ready`, `Base: Solution ${s.base ?? "?"}${s.base ? ` (${s.contenders.find((c) => c.label === s.base)?.kind})` : ""}. Report: ${s.report}`);
  await closeAll(hub, s);
  return s;
}

/** Have the author of the chosen base solution build the merged version in its worktree. */
export async function applyVerdict(hub: Hub, id: number, o: { label?: string; onProgress?: (s: VerdictState) => void } = {}): Promise<VerdictState> {
  const s = hub.db.getVerdict<VerdictState>(id);
  if (!s) throw new Error(`no verdict #${id}`);
  if (!s.verdict) throw new Error(`verdict #${id} has no result to apply`);
  const label = (o.label ?? s.base ?? "").toUpperCase();
  const c = s.contenders.find((x) => x.label === label && x.status === "done");
  if (!c) throw new Error(`pick which solution to build on (A–${s.contenders.at(-1)?.label})`);
  const save = () => {
    hub.db.saveVerdict(s.id, s);
    o.onProgress?.(structuredClone(s));
  };
  s.status = "applying";
  s.applied = { agent: c.agent };
  save();
  const others = s.contenders.filter((x) => x !== c && x.status === "done");
  const prompt =
    s.mode === "code"
      ? `A reviewer compared your solution (Solution ${c.label}) with other agents' solutions to the same task and wrote the verdict below. Build the final version in your worktree on top of your solution, following the verdict and merge plan exactly, and fix the bugs it lists. ${
          others.length ? `The other solutions are on these branches (read them with git show / git diff, don't check them out): ${others.map((x) => `Solution ${x.label} = ${x.branch} (${x.path})`).join("; ")}.` : ""
        } Run the tests, commit with a clear message, and reply with what you took from where.\n\n${untrusted("verdict", s.verdict)}`
      : `Rewrite your answer into the final version using this verdict (take the best parts named from the other answers):\n\n${untrusted("verdict", s.verdict)}`;
  try {
    const sess = await hub.ensure({ name: c.agent, agent: c.kind, cwd: s.cwd, worktree: s.mode === "code", policy: s.mode === "code" ? "allow-all" : "reject-all", role: `verdict #${s.id} builder`, resume: true });
    const r = await sess.runOnce(prompt, { automatic: false });
    s.applied.reply = sess.lastReply;
    if (r.error) throw new Error(r.error);
    s.status = "applied";
  } catch (e: any) {
    s.applied.error = String(e?.message ?? e).slice(0, 500);
    s.status = "done";
  }
  s.report = writeReport(s);
  save();
  if (s.status === "applied") hub.db.send("hive", "owner", `verdict #${s.id} built`, `${c.agent} built the merged version on ${c.branch ?? "its answer"}. Review and merge it (hive merge ${c.agent}).`);
  return s;
}

async function closeAll(hub: Hub, s: VerdictState) {
  for (const n of [...s.contenders.map((c) => c.agent), s.judgeAgent]) await hub.remove(n, false).catch(() => {});
}

function writeReport(s: VerdictState): string {
  const path = join(s.cwd, "out", "verdicts", `verdict-${s.id}.md`);
  const md = [
    `# Verdict #${s.id}`,
    `${new Date(s.ts).toLocaleString()} · mode: ${s.mode} · judge: ${s.judgeKind}${s.judgeModel ? ` (${s.judgeModel})` : ""} · status: ${s.status}`,
    `## Task\n${s.prompt}`,
    `## Contenders (revealed)\n${s.contenders
      .map((c) => `- **Solution ${c.label}** = ${c.kind} (${c.agent}) — ${c.status}${c.branch ? ` · branch ${c.branch}` : ""}${c.ms ? ` · ${Math.round(c.ms / 1000)}s` : ""}${c.error ? ` · ${c.error}` : ""}${c.diffStat ? `\n\n  \`\`\`\n  ${c.diffStat.split("\n").join("\n  ")}\n  \`\`\`` : ""}`)
      .join("\n")}`,
    s.verdict ? `## Judge's verdict\n${s.verdict}` : s.error ? `## Failed\n${s.error}` : "",
    s.applied ? `## Applied by ${s.applied.agent}\n${s.applied.error ? `Failed: ${s.applied.error}` : (s.applied.reply ?? "")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  saveOutput(path, md);
  return path;
}
