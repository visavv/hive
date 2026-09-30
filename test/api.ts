/**
 * The built-in API agent (api/agent.ts) against a fake OpenAI-compatible
 * server on 127.0.0.1: streaming, tool calls into the hive, file tools under
 * permission policies, usage, model picker, errors, cancel, resume, agents.json.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hub } from "../src/core/hub.js";
import { AGENTS, customAgentDef, expandVars, loadCustomAgents, readCustomAgents, saveCustomAgent } from "../src/core/agents.js";
import { assert, finish, freshDir, sleep } from "./util.js";

const dir = freshDir(".hive-test-api");
process.env.HIVE_HOME = join(dir, "home");
const work = join(dir, "work");
freshDir(work);
writeFileSync(join(work, "notes.txt"), "the secret word is PINEAPPLE\n");

// ---- fake API ----
const requests: any[] = [];
let authFail = false;
function sse(res: ServerResponse, chunks: any[], delayMs = 0) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  let i = 0;
  const next = () => {
    if (res.destroyed) return;
    if (i >= chunks.length) {
      res.end("data: [DONE]\n\n");
      return;
    }
    res.write(`data: ${JSON.stringify(chunks[i++])}\n\n`);
    delayMs ? setTimeout(next, delayMs) : next();
  };
  next();
}
const text = (t: string) => ({ choices: [{ index: 0, delta: { content: t } }] });
const done = (reason = "stop") => ({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const usage = (p: number, c: number) => ({ choices: [], usage: { prompt_tokens: p, completion_tokens: c, total_tokens: p + c } });
const call = (id: string, name: string, args: object) => [
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] } }] },
  // arguments arrive in pieces, like real streams
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args).slice(0, 5) } }] } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args).slice(5) } }] } }] },
  done("tool_calls"),
];

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  if (authFail || req.headers.authorization !== "Bearer sk-test") {
    res.writeHead(401).end(JSON.stringify({ error: { message: "invalid api key" } }));
    return;
  }
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "fake-large" }, { id: "fake-small" }] }));
    return;
  }
  let body = "";
  for await (const c of req) body += c;
  const j = JSON.parse(body);
  requests.push(j);
  const msgs: any[] = j.messages;
  const last = msgs.at(-1);
  const lastUser = [...msgs].reverse().find((m) => m.role === "user")?.content ?? "";
  if (last.role === "tool") return sse(res, [text(`tool said: ${String(last.content).slice(0, 80)}`), done(), usage(50, 5)]);
  if (/mail bob/.test(lastUser)) return sse(res, [...call("c1", "hive_send", { to: "bob", subject: "hi", body: "hello from the api agent" }), usage(30, 10)]);
  if (/read notes/.test(lastUser)) return sse(res, [...call("c2", "read_file", { path: "notes.txt" }), usage(30, 10)]);
  if (/read outside/.test(lastUser)) return sse(res, [...call("c3", "read_file", { path: "../../etc/passwd" }), usage(30, 10)]);
  if (/write it/.test(lastUser)) return sse(res, [...call("c4", "write_file", { path: "out/result.md", content: "# done\n" }), usage(30, 10)]);
  if (/slowly/.test(lastUser)) return sse(res, Array.from({ length: 50 }, (_, i) => text(`${i} `)), 100);
  if (/what did I say/.test(lastUser)) {
    const said = msgs.filter((m) => m.role === "user").map((m) => m.content).join(" | ");
    return sse(res, [text(`you said: ${said}`), done(), usage(20, 5)]);
  }
  sse(res, [text("Hello "), text(`from ${j.model}`), done(), usage(12, 3)]);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as any).port;
const base = `http://127.0.0.1:${port}/v1`;

// ---- agents.json ----
assert(expandVars("${NOPE_X:-dflt}") === "dflt" && expandVars("a${HOME}b").length > 2, "${VAR:-default} expansion");
let threw = "";
try {
  customAgentDef("x", { type: "api", base, keyEnv: "sk-live-abc 123", model: "m" });
} catch (e: any) {
  threw = e.message;
}
assert(/env.*variable name/i.test(threw), "a key pasted where the env var name goes is refused");
saveCustomAgent("fake", { type: "api", label: "Fake API", base, keyEnv: "FAKE_API_KEY", model: "fake-small" });
assert(!readFileSync(join(process.env.HIVE_HOME!, "agents.json"), "utf8").includes("sk-test"), "agents.json stores the env var name, never the key");
assert(loadCustomAgents().includes("fake") && AGENTS.fake?.api, "custom API agent loaded from agents.json");
assert(AGENTS["gemini-api"] && AGENTS.openrouter && AGENTS.ollama && AGENTS["openai-api"], "built-in Gemini / OpenRouter / OpenAI / Ollama entries");
saveCustomAgent("claude", { type: "api", base, model: "m" });
loadCustomAgents();
assert(!AGENTS.claude.api, "agents.json can't replace a built-in agent");
saveCustomAgent("claude", null);
assert(!("claude" in readCustomAgents()), "custom agent removed");

// ---- missing key ----
delete process.env.FAKE_API_KEY;
const hub = new Hub({ hiveDb: join(dir, "hive.db"), pollMs: 200 });
const nokey = await hub.add({ name: "nokey", agent: "fake", cwd: work, policy: "allow-reads" });
const r0 = await nokey.runOnce("hello", { automatic: false });
assert(/FAKE_API_KEY is not set/.test(r0.error ?? ""), `missing key names the env var (${r0.error})`);
await hub.remove("nokey");

process.env.FAKE_API_KEY = "sk-test";
const db = hub.db;
const a = await hub.add({ name: "gem", agent: "fake", cwd: work, policy: "allow-reads" });

// model picker from /models
const model = a.configOptions.find((o) => o.id === "model") as any;
assert(model && model.currentValue === "fake-small" && model.options.some((o: any) => o.value === "fake-large"), "model picker lists the endpoint's models");

// plain streamed reply + usage
let r = await a.runOnce("hello", { automatic: false });
assert(r.stopReason === "end_turn" && a.lastReply.includes("Hello from fake-small"), `streamed reply (${a.lastReply})`);
assert(requests.at(-1).messages[0].role === "system" && requests.at(-1).tools?.some((t: any) => t.function.name === "hive_send"), "hive tools offered to the model");
const used = db.usageSince(0).find((u) => u.provider === "fake");
assert(used?.tokens === 15, `tokens recorded under the provider (${used?.tokens})`);

// switch model
await a.setConfigOption("model", "fake-large");
await a.runOnce("hello", { automatic: false });
assert(a.lastReply.includes("from fake-large") && requests.at(-1).model === "fake-large", "model switch applies to the next request");

// tool call → hive mail
db.upsertAgent({ name: "bob", kind: "mock", cwd: work, role: "", status: "asleep", status_note: "", session_id: null });
r = await a.runOnce("please mail bob", { automatic: false });
const toBob = db.inbox("bob", true);
assert(toBob.some((m) => m.from_agent === "gem" && m.body === "hello from the api agent"), "tool call (arguments streamed in pieces) sent hive mail");
assert(a.lastReply.includes("tool said:"), "tool result fed back to the model");

// file tools under allow-reads: read ok, outside refused, write rejected
await a.runOnce("read notes", { automatic: false });
assert(a.lastReply.includes("PINEAPPLE"), "read_file works under allow-reads");
await a.runOnce("read outside", { automatic: false });
assert(/outside the working folder/.test(a.lastReply), "paths outside the folder are refused");
await a.runOnce("write it", { automatic: false });
assert(!existsSync(join(work, "out/result.md")) && /rejected/.test(a.lastReply), "write_file rejected by allow-reads policy");

// cancel
const p = a.runOnce("do this slowly", { automatic: false });
await sleep(600);
await a.cancel();
r = await p;
assert(r.stopReason === "cancelled", `cancel stops a streaming turn (${r.stopReason})`);
const sid = a.sessionId!;
await hub.remove("gem", false);

// resume: history comes back from disk; allow-all lets it write
const b = await hub.add({ name: "gem", agent: "fake", cwd: work, policy: "allow-all", resumeSessionId: sid });
await b.runOnce("what did I say", { automatic: false });
assert(b.lastReply.includes("please mail bob") && b.lastReply.includes("hello"), "resumed session keeps the conversation");
await b.runOnce("write it", { automatic: false });
assert(readFileSync(join(work, "out/result.md"), "utf8") === "# done\n", "write_file works under allow-all");

// bad key
authFail = true;
r = await b.runOnce("hello", { automatic: false });
assert(/refused the key.*FAKE_API_KEY/.test(r.error ?? ""), `a rejected key says which env var to check (${r.error?.slice(0, 80)})`);
authFail = false;

await hub.close();
server.close();
finish("api");
