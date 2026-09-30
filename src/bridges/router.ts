/**
 * Chat bridge: lets the owner run hive from Discord or WhatsApp.
 *
 * Security model (keep it):
 *  - outbound connections only (the transports dial out; nothing listens)
 *  - only allowlisted sender ids are obeyed; everyone else is ignored
 *  - commands act as "owner": the same things the CLI can do, nothing more
 *  - tokens come from the environment, never from chat
 *  - rate limited; every command is logged to the hive event log
 *
 * Commands (one per message):
 *   help · status · jobs · report [12h] · inbox · bb [prefix]
 *   send <agent|@group|*> <text>   (or just "@agent text")
 *   stop <job id|agent> · start <job id>
 *   approve <n> [option#] · deny <n>          answer a permission prompt
 *   skill <name> key=value …                  run a skill, reply comes back here
 */
import type { Hub } from "../core/hub.js";
import type { SessionEvent } from "../core/session.js";
import type * as schema from "@agentclientprotocol/sdk";
import { buildReport, renderReport } from "../core/report.js";
import { describeSchedule, parseDuration } from "../core/scheduler.js";
import { findSkill } from "../core/skills.js";
import { runSkill } from "../core/skill-run.js";
import type { ChatTransport, IncomingChat } from "./types.js";

export interface BridgeOptions {
  hub: Hub;
  transport: ChatTransport;
  /** Sender ids allowed to command hive (required, non-empty). */
  allow: string[];
  /** Where to push notifications: a chat id, or "user:<id>" (default: DM the first allowed user). */
  notify?: string;
  /** Project folder (for report / skills). */
  cwd: string;
  /** Plain text without a command goes to this agent (e.g. "studio"). */
  defaultAgent?: string;
  /** Max commands per minute per sender. */
  rateLimit?: number;
  /** Forward job results/failures (default true). */
  jobNotices?: boolean;
}

interface PendingAsk {
  n: number;
  agent: string;
  title: string;
  options: schema.PermissionOption[];
  resolve: (optionId: string) => void;
}

export class Bridge {
  private asks = new Map<number, PendingAsk>();
  private askSeq = 0;
  private hits = new Map<string, number[]>();
  private awaitingReply = new Map<string, string>(); // agent -> chat to answer in
  private mailTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(private o: BridgeOptions) {
    if (!o.allow.length) throw new Error(`${o.transport.name} bridge: set an allowlist of sender ids (nobody would be able to use it, and anyone could otherwise)`);
  }

  get notifyTo(): string {
    return this.o.notify ?? `user:${this.o.allow[0]}`;
  }

  async start() {
    await this.o.transport.start((m) => void this.onMessage(m).catch((e) => this.say(m.chat, `error: ${e?.message ?? e}`)));
    // Mail agents send to the owner is forwarded here.
    this.mailTimer = setInterval(() => void this.forwardOwnerMail().catch(() => {}), 3000);
    this.mailTimer.unref?.();
    await this.say(this.notifyTo, `🐝 hive connected (${this.o.transport.name}). Send "help".`);
  }

  async stop() {
    this.stopped = true;
    if (this.mailTimer) clearInterval(this.mailTimer);
    for (const a of this.asks.values()) a.resolve(a.options.find((o) => o.kind.startsWith("reject"))?.optionId ?? a.options[0].optionId);
    this.asks.clear();
    await this.o.transport.stop();
  }

  /** Hub onEvent hook: forwards the reply of an agent you messaged from chat. */
  onAgentEvent(agent: string, e: SessionEvent) {
    if (e.type === "turn_end" && this.awaitingReply.has(agent)) {
      const chat = this.awaitingReply.get(agent)!;
      this.awaitingReply.delete(agent);
      const s = this.o.hub.sessions.get(agent);
      const reply = s?.lastReply?.trim() || `(${agent} finished: ${e.stopReason})`;
      void this.say(chat, `💬 ${agent}:\n${reply.slice(-3500)}`);
    }
  }

  /** Scheduler onJob hook. */
  onJobEvent(e: { type: string; job: { id: number; agent: string }; reason?: string; error?: string; until?: number }) {
    if (this.o.jobNotices === false) return;
    if (e.type === "job_end") void this.say(this.notifyTo, `⏱ job #${e.job.id} on ${e.job.agent} ended: ${e.reason}`);
    else if (e.type === "error") void this.say(this.notifyTo, `⚠ job #${e.job.id} on ${e.job.agent}: ${String(e.error).slice(0, 300)}`);
    else if (e.type === "paused") void this.say(this.notifyTo, `⏸ job #${e.job.id} paused by a usage limit until ${new Date(e.until!).toLocaleTimeString()}`);
  }

  /** Use as the hub's askPermission: the prompt goes to chat, the answer comes back from chat. */
  askPermission = (req: schema.RequestPermissionRequest, agent: string, signal?: AbortSignal): Promise<string> => {
    const n = ++this.askSeq;
    const title = req.toolCall.title ?? "tool";
    const reject = req.options.find((o) => o.kind.startsWith("reject"))?.optionId ?? req.options[0].optionId;
    return new Promise((resolve) => {
      if (this.stopped) return resolve(reject);
      this.asks.set(n, { n, agent, title, options: req.options, resolve });
      signal?.addEventListener("abort", () => {
        if (this.asks.delete(n)) void this.say(this.notifyTo, `🔐 #${n} withdrawn (cancelled or timed out)`);
      });
      const opts = req.options.map((o, i) => `${i + 1}. ${o.name}`).join("  ");
      const detail = describeTool(req);
      void this.say(
        this.notifyTo,
        `🔐 #${n} ${agent} wants: ${title}${detail ? `\n${detail}` : ""}\n${opts}\nreply "approve ${n}" (or "approve ${n} <option#>") / "deny ${n}"`,
      );
    });
  };

  // ---- incoming ----

  private allowed(from: string) {
    return this.o.allow.includes(from);
  }

  private rateOk(from: string) {
    const now = Date.now();
    const list = (this.hits.get(from) ?? []).filter((t) => now - t < 60_000);
    list.push(now);
    this.hits.set(from, list);
    return list.length <= (this.o.rateLimit ?? 20);
  }

  async onMessage(m: IncomingChat) {
    if (!this.allowed(m.from)) return; // silently ignore strangers
    const text = m.text.trim();
    if (!text) return;
    if (!this.rateOk(m.from)) return this.say(m.chat, "slow down — too many commands this minute");
    const db = this.o.hub.db;
    db.log("bridge", "command", { via: this.o.transport.name, from: m.from, text: text.slice(0, 200) });

    const at = text.match(/^@([\w.-]+)\s+([\s\S]+)$/);
    if (at) return this.sendTo(m.chat, db.groupMembers(at[1]).length && !db.getAgent(at[1]) ? `@${at[1]}` : at[1], at[2]);
    const [cmd, ...args] = text.split(/\s+/);
    const rest = text.slice(cmd.length).trim();
    switch (cmd.toLowerCase()) {
      case "help":
      case "?":
        return this.say(
          m.chat,
          [
            "status · jobs · report [12h] · inbox · bb [prefix]",
            "send <agent|@group|*> <text>  — or  @agent <text>",
            "stop <job#|agent> · start <job#>",
            "approve <n> [option#] · deny <n>",
            "skill <name> key=value …",
          ].join("\n"),
        );
      case "status": {
        const rows = db.listAgents().filter((a) => a.kind);
        if (!rows.length) return this.say(m.chat, "no agents");
        const lines = rows.map((a) => {
          const st = db.effectiveStatus(a);
          const icon = st === "working" ? "🟡" : st === "waiting" ? "🟣" : st === "error" ? "🔴" : st === "idle" ? "🟢" : "⚪";
          const unread = db.unreadCount(a.name);
          return `${icon} ${a.name} (${a.kind}) ${st}${unread ? ` ✉${unread}` : ""}${a.status_note ? ` — ${a.status_note.slice(0, 60)}` : ""}`;
        });
        const pending = this.asks.size ? `\n🔐 ${this.asks.size} waiting for approval: ${[...this.asks.keys()].map((n) => "#" + n).join(" ")}` : "";
        return this.say(m.chat, lines.join("\n") + pending);
      }
      case "jobs": {
        const jobs = db.listJobs(false);
        if (!jobs.length) return this.say(m.chat, "no active jobs");
        return this.say(m.chat, jobs.map((j) => `#${j.id} ${j.kind} ${j.agent}: ${describeSchedule(j)} · ${j.runs} runs${j.last_error ? ` · ⚠ ${j.last_error.slice(0, 60)}` : ""}`).join("\n"));
      }
      case "report": {
        let ms = 12 * 3_600_000;
        if (args[0])
          try {
            ms = parseDuration(args[0]);
          } catch {
            return this.say(m.chat, `bad duration "${args[0]}" (e.g. 12h)`);
          }
        const cwds = [this.o.cwd, ...db.listAgents().map((a) => a.cwd).filter(Boolean)];
        return this.say(m.chat, renderReport(await buildReport(db, Date.now() - ms, cwds)));
      }
      case "inbox": {
        const msgs = db.inbox("owner", true, 20);
        db.markRead(msgs.map((x) => x.id), "owner");
        this.forwarded = Math.max(this.forwarded, ...msgs.map((x) => x.id));
        if (!msgs.length) return this.say(m.chat, "no unread mail");
        return this.say(m.chat, msgs.map((x) => `✉ ${x.from_agent}: ${x.subject}\n${x.body.slice(0, 800)}`).join("\n\n"));
      }
      case "bb": {
        const rows = db.bbList(args[0] ?? "");
        if (!rows.length) return this.say(m.chat, "blackboard is empty");
        return this.say(m.chat, rows.slice(0, 30).map((r) => `• ${r.key}: ${r.value.replace(/\s+/g, " ").slice(0, 200)}`).join("\n"));
      }
      case "send": {
        const to = args[0];
        const body = rest.slice(to?.length ?? 0).trim();
        if (!to || !body) return this.say(m.chat, "usage: send <agent|@group|*> <text>");
        return this.sendTo(m.chat, to, body);
      }
      case "stop": {
        const t = args[0];
        if (!t) return this.say(m.chat, "usage: stop <job#|agent>");
        const jobs = /^\d+$/.test(t) ? [db.getJob(Number(t))].filter(Boolean) : db.listJobs(false).filter((j) => j.agent === t);
        if (!jobs.length) {
          const s = this.o.hub.sessions.get(t);
          if (s?.busyNow) {
            await s.cancel();
            return this.say(m.chat, `cancelled ${t}'s current turn`);
          }
          return this.say(m.chat, `no active job or busy agent "${t}"`);
        }
        for (const j of jobs) db.endJob(j!.id, "stopped");
        return this.say(m.chat, `stopped ${jobs.map((j) => "#" + j!.id).join(" ")}`);
      }
      case "start": {
        const id = Number(args[0]);
        const j = db.getJob(id);
        if (!j) return this.say(m.chat, `no job #${args[0]}`);
        db.updateJob(id, { enabled: 1, ended_reason: null, failures: 0, last_error: null, next_run: Date.now() });
        return this.say(m.chat, `job #${id} re-enabled`);
      }
      case "approve":
      case "deny": {
        const n = Number((args[0] ?? "").replace("#", ""));
        const a = this.asks.get(n);
        if (!a) return this.say(m.chat, this.asks.size ? `no prompt #${args[0]} (open: ${[...this.asks.keys()].map((k) => "#" + k).join(" ")})` : "no open permission prompts");
        this.asks.delete(n);
        let opt: schema.PermissionOption | undefined;
        if (cmd.toLowerCase() === "deny") opt = a.options.find((o) => o.kind === "reject_once") ?? a.options.find((o) => o.kind.startsWith("reject"));
        else if (args[1]) opt = a.options[Number(args[1]) - 1];
        else opt = a.options.find((o) => o.kind === "allow_once") ?? a.options.find((o) => o.kind.startsWith("allow"));
        if (!opt) {
          this.asks.set(n, a);
          return this.say(m.chat, `no such option; choose 1-${a.options.length}`);
        }
        a.resolve(opt.optionId);
        return this.say(m.chat, `#${n} → ${opt.name}`);
      }
      case "skill": {
        const name = args[0];
        if (!name) return this.say(m.chat, "usage: skill <name> key=value …");
        const params: Record<string, string> = {};
        // key=value pairs; values may contain spaces until the next key=
        const kv = rest.slice(name.length).trim();
        for (const mm of kv.matchAll(/([\w-]+)=([\s\S]*?)(?=\s+[\w-]+=|$)/g)) params[mm[1]] = mm[2].trim();
        const sk = findSkill(this.o.cwd, name);
        await this.say(m.chat, `✦ running ${name}…`);
        const r = await runSkill(this.o.hub, sk, params, { cwd: this.o.cwd });
        return this.say(m.chat, `✦ ${name}${r.saved ? ` (saved ${r.saved})` : ""}:\n${r.reply.trim().slice(-3500) || r.result.stopReason}`);
      }
      default:
        if (this.o.defaultAgent) return this.sendTo(m.chat, this.o.defaultAgent, text);
        return this.say(m.chat, `unknown command "${cmd}" — send "help"`);
    }
  }

  /** Message an agent as the owner; its reply comes back to this chat. */
  private async sendTo(chat: string, to: string, body: string) {
    const db = this.o.hub.db;
    if (to.startsWith("@") ? !db.groupMembers(to.slice(1)).length : to !== "*" && !db.getAgent(to))
      return this.say(chat, `no agent or group "${to}" (status lists agents)`);
    db.send("owner", to, body.split("\n")[0].slice(0, 80), body);
    if (!to.startsWith("@") && to !== "*") this.awaitingReply.set(to, chat);
    const running = this.o.hub.sessions.has(to);
    return this.say(chat, `→ ${to}${running ? "" : " (not running here; it's woken to read it if hive serve can start it)"}`);
  }

  private forwarded = 0;
  private async forwardOwnerMail() {
    const db = this.o.hub.db;
    if (!db.db.open) return;
    const msgs = db.inbox("owner", true, 20).filter((x) => x.id > this.forwarded);
    for (const x of msgs) {
      this.forwarded = Math.max(this.forwarded, x.id);
      await this.say(this.notifyTo, `✉ ${x.from_agent}: ${x.subject}\n${x.body.slice(0, 1500)}`);
    }
    if (msgs.length) db.markRead(msgs.map((x) => x.id), "owner");
  }

  /** Send, splitting long texts to the network's limit. */
  async say(to: string, text: string) {
    if (this.stopped) return;
    for (const part of chunk(text, this.o.transport.maxLength)) await this.o.transport.send(to, part);
  }
}

function describeTool(req: schema.RequestPermissionRequest): string {
  const tc = req.toolCall as any;
  const ri = tc.rawInput ?? {};
  const s = ri.command ?? ri.file_path ?? ri.path ?? (tc.locations?.[0]?.path as string | undefined);
  return s ? String(s).slice(0, 300) : "";
}

/** Split on line boundaries where possible. */
export function chunk(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (line.length > max) {
      if (cur) out.push(cur);
      cur = "";
      for (let i = 0; i < line.length; i += max) out.push(line.slice(i, i + max));
      continue;
    }
    if ((cur ? cur.length + 1 : 0) + line.length > max) {
      out.push(cur);
      cur = line;
    } else cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) out.push(cur);
  return out;
}
