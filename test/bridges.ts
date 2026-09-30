/**
 * Chat bridge wiring, without real Discord/WhatsApp accounts:
 *  - router + hub + mock agents through a fake transport (commands, allowlist,
 *    permission approve/deny from chat, replies and owner mail forwarded, skills, jobs, rate limit)
 *  - the Discord and WhatsApp adapters against fake clients shaped like discord.js / Baileys
 */
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hub } from "../src/core/hub.js";
import { Bridge, chunk } from "../src/bridges/router.js";
import { DiscordTransport } from "../src/bridges/discord.js";
import { WhatsAppTransport } from "../src/bridges/whatsapp.js";
import { createBridges } from "../src/bridges/index.js";
import type { ChatTransport, IncomingChat } from "../src/bridges/types.js";
import { assert, finish, freshDir, mock, sleep, until } from "./util.js";

class FakeTransport implements ChatTransport {
  name = "fake";
  maxLength = 500;
  out: { to: string; text: string }[] = [];
  private h?: (m: IncomingChat) => void;
  async start(h: (m: IncomingChat) => void) {
    this.h = h;
  }
  async send(to: string, text: string) {
    this.out.push({ to, text });
  }
  async stop() {}
  user(text: string, from = "111") {
    this.h!({ from, chat: "chat-1", text });
  }
  all() {
    return this.out.map((o) => o.text).join("\n");
  }
}

const dir = freshDir(".hive-test-bridges");
const work = freshDir(join(dir, "work"));
execFileSync("git", ["init", "-q"], { cwd: work });
mkdirSync(join(work, ".hive-skills"), { recursive: true });
writeFileSync(join(work, ".hive-skills", "shout.md"), "---\nname: shout\ndescription: test\nagent: mock\nparams:\n  - name: word\n    type: text\n    required: true\n---\nWrite 2 title options about {{word}}\n");

const t = new FakeTransport();
let bridge!: Bridge;
const hub = new Hub({
  hiveDb: join(dir, "hive.db"),
  pollMs: 200,
  onEvent: (a, e) => bridge?.onAgentEvent(a, e),
  defaults: { askPermission: (req, agent, signal) => bridge.askPermission(req, agent, signal) },
});
bridge = new Bridge({ hub, transport: t, allow: ["111"], cwd: work, rateLimit: 30 });
await bridge.start();
assert(t.out[0]?.to === "user:111" && /hive connected/.test(t.out[0].text), "on start it greets the first allowed user by DM");

await hub.add({ name: "coder", agent: mock("coder"), cwd: work, policy: "ask" });
hub.run();

t.user("status", "999");
t.user("help", "999");
await sleep(300);
assert(t.out.length === 1, "messages from senders not on the allowlist are ignored");

t.user("help");
await until(() => /approve <n>/.test(t.all()), 3000, "help");
assert(true, "help lists the commands");
t.user("status");
await until(() => /coder \(mock\)/.test(t.all()), 3000, "status");
assert(true, "status lists agents with their state");

// message an agent; it asks permission; approve from chat; its reply comes back
t.user("@coder please edit something");
await until(() => /🔐 #1 coder wants: Write src\/fake.ts/.test(t.all()), 15_000, "permission prompt in chat");
assert(true, "an agent's permission prompt is posted to chat with approve/deny instructions");
t.user("approve 1");
await until(() => /💬 coder:[\s\S]*edit allowed/.test(t.all()), 15_000, "reply forwarded");
assert(true, "approve from chat lets the agent continue, and its reply is forwarded");

t.user("send coder please edit again");
await until(() => /🔐 #2/.test(t.all()), 15_000, "second prompt");
t.user("deny 2");
await until(() => /edit rejected/.test(t.all()), 15_000, "deny");
assert(true, "deny from chat rejects the action");
t.user("approve 99");
await until(() => /no open permission prompts|no prompt #99/.test(t.all()), 3000, "bad approve");
assert(true, "approving an unknown prompt number is reported");

// mail agents send to the owner is pushed to chat
t.out = [];
await hub.sessions.get("coder")!.prompt("tellowner: nightly build is green");
await until(() => /✉ coder: fyi[\s\S]*nightly build is green/.test(t.all()), 8000, "owner mail");
assert(t.out.some((o) => o.to === "user:111"), "owner mail from agents is forwarded to chat");
assert(hub.db.unreadCount("owner") === 0, "…and marked read");

// jobs, stop, report, bb
const jid = hub.db.addJob({ agent: "coder", agent_kind: "mock", cwd: work, kind: "interval", every_ms: 3_600_000, next_run: Date.now() + 3_600_000, prompt: "check" });
t.user("jobs");
await until(() => new RegExp(`#${jid} interval coder`).test(t.all()), 3000, "jobs");
t.user(`stop ${jid}`);
await until(() => hub.db.getJob(jid)?.enabled === 0, 3000, "stop");
assert(true, "jobs lists and stop disables a job from chat");
hub.db.bbSet("ideas/ready/x", "a polished idea", "polisher");
t.user("bb ideas/");
await until(() => /ideas\/ready\/x: a polished idea/.test(t.all()), 3000, "bb");
t.user("report 1h");
await until(() => /JOBS/.test(t.all()), 5000, "report");
assert(true, "bb and report work from chat");

// skills from chat
t.user("skill shout word=robots that fold laundry");
await until(() => /✦ shout[\s\S]*A title/.test(t.all()), 15_000, "skill");
assert(true, "a skill runs from chat and its result comes back");

// long messages are split; rate limit
assert(chunk("a\n".repeat(600), 500).every((c) => c.length <= 500), "long texts are split to the network limit");
const t2 = new FakeTransport();
const b2 = new Bridge({ hub, transport: t2, allow: ["111"], cwd: work, rateLimit: 3 });
await b2.start();
for (let i = 0; i < 5; i++) t2.user("help");
await sleep(300);
assert(/slow down/.test(t2.all()), "rate limit per sender");
await b2.stop();

// configuration errors
let err = "";
try {
  createBridges(["discord"], hub, { cwd: work, stateDir: dir, env: { HIVE_DISCORD_TOKEN: "x" } });
} catch (e: any) {
  err = e.message;
}
assert(/allowlist/.test(err), "a bridge refuses to start without an allowlist");
try {
  createBridges(["discord"], hub, { cwd: work, stateDir: dir, env: { HIVE_DISCORD_ALLOW: "1" } });
} catch (e: any) {
  err = e.message;
}
assert(/HIVE_DISCORD_TOKEN/.test(err), "discord needs a token from the environment");

await bridge.stop();
await hub.close();

// ---- Discord adapter against a fake discord.js client ----
class FakeDiscord extends EventEmitter {
  user = { id: "bot" };
  sent: string[] = [];
  async login() {
    setTimeout(() => this.emit("clientReady"), 10);
  }
  destroy() {}
  channels = { fetch: async (id: string) => ({ send: async (t: string) => void this.sent.push(`channel:${id}:${t}`) }) };
  users = { fetch: async (id: string) => ({ createDM: async () => ({ send: async (t: string) => void this.sent.push(`dm:${id}:${t}`) }) }) };
}
const fd = new FakeDiscord();
const dt = new DiscordTransport({ token: "t", channel: "C1", makeClient: async () => fd as any });
const got: IncomingChat[] = [];
await dt.start((m) => got.push(m));
fd.emit("messageCreate", { author: { id: "111" }, channelId: "DM1", guildId: null, content: "status" });
fd.emit("messageCreate", { author: { id: "111" }, channelId: "C1", guildId: "G", content: "jobs" });
fd.emit("messageCreate", { author: { id: "111" }, channelId: "OTHER", guildId: "G", content: "nope" });
fd.emit("messageCreate", { author: { id: "bot", bot: true }, channelId: "DM1", guildId: null, content: "echo" });
assert(got.map((g) => g.text).join(",") === "status,jobs" && got[0].from === "111" && got[0].chat === "DM1", "discord: DMs and the configured channel are read; other channels and bots ignored");
await dt.send("user:111", "hi");
await dt.send("C1", "yo");
assert(fd.sent.join("|") === "dm:111:hi|channel:C1:yo", "discord: sends DMs to users and messages to channels");

// ---- WhatsApp adapter against a fake Baileys socket ----
const ev = new EventEmitter();
const waSent: string[] = [];
let qrShown = "";
const wt = new WhatsAppTransport({
  authDir: join(dir, "wa"),
  onQr: (q) => (qrShown = q),
  makeSocket: async (onQr) => {
    setTimeout(() => onQr("QR-CODE-DATA"), 5);
    return { ev: { on: (e: string, f: any) => void ev.on(e, f) }, sendMessage: async (jid: string, c: { text: string }) => void waSent.push(`${jid}:${c.text}`) };
  },
});
const wgot: IncomingChat[] = [];
await wt.start((m) => wgot.push(m));
await sleep(20);
ev.emit("messages.upsert", {
  type: "notify",
  messages: [
    { key: { remoteJid: "358401234567@s.whatsapp.net", fromMe: false }, message: { conversation: "status" } },
    { key: { remoteJid: "358401234567@s.whatsapp.net", fromMe: true }, message: { conversation: "mine" } },
    { key: { remoteJid: "12345-678@g.us", fromMe: false }, message: { conversation: "group chatter" } },
    { key: { remoteJid: "358401234567@s.whatsapp.net", fromMe: false }, message: { extendedTextMessage: { text: "report 12h" } } },
  ],
});
assert(wgot.map((g) => g.text).join(",") === "status,report 12h" && wgot[0].from === "358401234567", "whatsapp: direct messages read (plain and extended text); own messages and groups ignored");
await wt.send("user:+358 40 123 4567", "hello");
assert(waSent[0] === "358401234567@s.whatsapp.net:hello", "whatsapp: replies go to the normalized number");
assert(qrShown === "QR-CODE-DATA", "whatsapp: the pairing QR is surfaced on first login");
await wt.stop();

finish("bridges");
