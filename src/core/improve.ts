/**
 * "Improve my prompt" inside a chat: turn a rough draft into a full prompt for
 * THIS agent, without putting the request into its conversation. A hidden helper
 * of the same agent type (so it uses the same subscription) writes the prompt from
 * the draft plus what the agent is doing (role, folder, last few messages); the
 * owner edits it if they like and sends it in the same chat.
 *
 * The helper runs read-nothing (reject-all), starts a fresh conversation every
 * time, and closes after a few idle minutes. Its turns show up in token stats
 * under the "prompting" task.
 */
import type { Hub } from "./hub.js";

const IDLE_MS = 10 * 60_000;
const timers = new Map<string, NodeJS.Timeout>();

export function helperName(agent: string): string {
  return `pe-${agent}`.slice(0, 40);
}

/** The last few things said in this agent's chat, oldest first, trimmed. */
export function recentChat(hub: Hub, agent: string, n = 6): { who: "you" | "agent"; text: string }[] {
  const rows = hub.db.db
    .prepare(`SELECT type, data FROM events WHERE agent=? AND type IN ('prompt','reply') ORDER BY id DESC LIMIT ?`)
    .all(agent, n) as { type: string; data: string }[];
  return rows
    .reverse()
    .map((r) => {
      let text = "";
      try {
        text = String(JSON.parse(r.data).text ?? "");
      } catch {}
      // briefings ride on the first prompt; keep only what the owner typed
      const sep = text.lastIndexOf("\n\n---\n\n");
      if (r.type === "prompt" && sep >= 0 && /You are agent "/.test(text.slice(0, sep))) text = text.slice(sep + 7);
      return { who: r.type === "prompt" ? ("you" as const) : ("agent" as const), text: text.length > 1200 ? text.slice(0, 1200) + " …" : text };
    })
    .filter((m) => m.text.trim() && !/^\[(hive job|follow-up from)|^You have \d+ unread/.test(m.text));
}

export function buildImproveRequest(o: { draft: string; agent: string; kind: string; role?: string; cwd: string; chat: { who: string; text: string }[] }): string {
  const chat = o.chat.length ? o.chat.map((m) => `${m.who === "you" ? "OWNER" : "AGENT"}: ${m.text}`).join("\n\n") : "(no messages yet)";
  return [
    `You are a prompt engineer. The owner is about to send a message to a coding agent and wants it turned into a clear, complete prompt. Write ONLY the improved message; you are not the agent and must not do the task yourself.`,
    ``,
    `The agent: "${o.agent}" (${o.kind}${o.role ? `, role: ${o.role}` : ""}), working in ${o.cwd}.`,
    `Recent conversation with it, for context (may be empty):`,
    `<<<`,
    chat,
    `>>>`,
    ``,
    `The owner's draft:`,
    `<<<`,
    o.draft.trim(),
    `>>>`,
    ``,
    `Write the message the owner should send instead. It should:`,
    `- keep the owner's intent and wording where it's already clear; never invent requirements, files or facts — where something is unknown, tell the agent to find out or to ask;`,
    `- resolve references like "that bug" or "it" from the conversation when they're unambiguous;`,
    `- say what to do, where, what to leave alone, how to check the result (tests, run, compare), and what to report back;`,
    `- be as short as the task allows: a small request stays a few lines; a big one gets steps and acceptance criteria;`,
    `- be written to the agent in the second person, in the owner's language.`,
    ``,
    `Reply with the improved message inside one fenced \`\`\`text block and nothing else.`,
  ].join("\n");
}

/** The prompt from the helper's reply: the first fenced block, else the whole reply. */
export function extractPrompt(reply: string): string {
  const m = reply.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
  return (m ? m[1] : reply).trim();
}

export async function improvePrompt(hub: Hub, agent: string, draft: string): Promise<string> {
  if (!draft.trim()) throw new Error("write a rough prompt first");
  const target = hub.sessions.get(agent);
  if (!target) throw new Error(`${agent} isn't running`);
  const name = helperName(agent);
  const helper = await hub.ensure({ name, agent: target.def.id, cwd: target.cwd, policy: "reject-all", role: "prompt engineer (helper)" });
  clearTimeout(timers.get(name));
  try {
    const r = await helper.runOnce(buildImproveRequest({ draft, agent, kind: target.def.id, role: target.role, cwd: target.cwd, chat: recentChat(hub, agent) }), {
      fresh: true,
      automatic: false,
    });
    if (r.error) throw new Error(r.error);
    const out = extractPrompt(helper.lastReply ?? "");
    if (!out) throw new Error("the helper returned nothing; try again");
    return out;
  } finally {
    timers.set(
      name,
      setTimeout(() => {
        timers.delete(name);
        void hub.remove(name).catch(() => {});
      }, IDLE_MS).unref(),
    );
  }
}
