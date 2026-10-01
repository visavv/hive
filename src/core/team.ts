/**
 * Teamwork (docs/TEAMWORK.md): one task broadcast to several agents gets one lead who plans and hands
 * out parts; the rest wait for its mail. Improvement ideas go to the coder, who asks the owner first.
 */

/** Briefing paragraph every agent gets. */
export const TEAM_POLICY = [
  `Teamwork: when the owner broadcasts one task to several agents, hive names one lead. The lead plans and hands each teammate only the part that fits their role (with the task itself in the message); the others wait for that mail instead of starting on their own, so nobody duplicates work.`,
  `Improvement ideas: an agent that finds improvements (e.g. on a scheduled job) sends the best few, numbered, with the files involved, to the coder agent if there is one (hive_send). A coder that receives improvement ideas from another agent does not build them yet: it lists them a line each and asks the owner which to do, ending its turn with that question, and starts only on the owner's yes.`,
].join(" ");

export interface Member {
  name: string;
  role: string;
  policy?: string;
}

/**
 * Who leads a team broadcast: a planner/lead role first, then a coder/builder, then the first agent
 * that can act (not chat-only). Ties keep the order you picked them in.
 */
export function pickLead(members: Member[]): Member | undefined {
  const can = members.filter((m) => m.policy !== "reject-all");
  const pool = can.length ? can : members;
  const by = (re: RegExp) => pool.find((m) => re.test(m.role));
  return by(/\b(lead|planner|plan|architect|orchestrat\w*|manager|pm)\b/i) ?? by(/\b(coder|developer|engineer|builder|programmer|dev)\b/i) ?? pool[0];
}

const who = (m: Member) => `${m.name}${m.role ? ` (${m.role})` : ""}`;

/** The prompt the lead gets. */
export function leadPrompt(task: string, lead: Member, team: Member[]): string {
  const rest = team.filter((m) => m.name !== lead.name);
  return [
    `[team broadcast from the owner — you lead] The owner sent this task to ${team.map(who).join(", ")}. The others are waiting for your mail and won't start on their own.`,
    `1. Make a short plan.`,
    `2. hive_send each teammate whose role fits a part of it: their part, the task below, and what to send back to you. Skip anyone whose role doesn't fit (a reviewer reviews once there is something to review; a chat-only agent only answers questions).`,
    `3. Do your own part, then tell the owner in a few lines who is doing what.`,
    rest.length ? `Teammates: ${rest.map(who).join(", ")}.` : "",
    ``,
    `Task: ${task}`,
  ]
    .filter((l, i) => l || i === 5)
    .join("\n");
}

/** The notice the others see in their pane (no turn is spent until the lead's mail arrives). */
export function waitNotice(task: string, lead: Member): string {
  const t = task.length > 80 ? task.slice(0, 79) + "…" : task;
  return `team broadcast "${t}": ${who(lead)} is leading — this agent waits for its part by mail`;
}

/** Label for the lead's prompt in the transcript. */
export const LEAD_MARK = "[team broadcast from the owner — you lead]";
