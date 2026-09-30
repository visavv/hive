/**
 * Running skills through the hub: a dedicated chat agent per skill
 * ("skill-<name>"), so you can keep talking to it afterwards ("shorter",
 * "more like #3") and it remembers the conversation.
 */
import type { Hub } from "./hub.js";
import type { PermissionPolicy, TurnResult } from "./session.js";
import { AGENTS } from "./agents.js";
import { extractSkill, outputPath, parseSkill, renderSkill, saveOutput, skillWriterPrompt, type Skill } from "./skills.js";

export function skillAgentName(skill: string): string {
  return `skill-${skill}`.replace(/[^\w.-]/g, "-").slice(0, 40);
}

export interface SkillRun {
  agent: string;
  result: TurnResult;
  reply: string;
  saved?: string;
}

export async function runSkill(
  hub: Hub,
  skill: Skill,
  values: Record<string, string>,
  o: { cwd: string; kind?: string; name?: string; fresh?: boolean },
): Promise<SkillRun> {
  const prompt = renderSkill(skill, values, o.cwd);
  const kind = o.kind ?? skill.agent ?? "claude";
  if (!AGENTS[kind]) throw new Error(`unknown agent "${kind}"`);
  const name = o.name ?? skillAgentName(skill.name);
  const session = await hub.ensure({
    name,
    agent: kind,
    cwd: o.cwd,
    role: `skill: ${skill.description}`.slice(0, 120),
    policy: skill.policy as PermissionPolicy,
    resume: false,
  });
  const result = await session.runOnce(prompt, { fresh: o.fresh ?? true });
  const reply = session.lastReply;
  let saved: string | undefined;
  const out = outputPath(skill, o.cwd);
  if (out && reply.trim() && !result.error) {
    saveOutput(out, reply);
    saved = out;
  }
  return { agent: name, result, reply, saved };
}

/** Ask an agent to write a new skill file from a description; returns the file text (validated). */
export async function writeSkill(hub: Hub, name: string, description: string, o: { cwd: string; kind: string }): Promise<string> {
  const session = await hub.ensure({ name: "skill-writer", agent: o.kind, cwd: o.cwd, role: "writes hive skills", policy: "reject-all" });
  const r = await session.runOnce(skillWriterPrompt(name, description), { fresh: true });
  if (r.error) throw new Error(r.error);
  const text = extractSkill(session.lastReply);
  const s = parseSkill(text, `${name}.md`);
  if (s.name !== name) return text.replace(/^name:.*$/m, `name: ${name}`);
  return text;
}
