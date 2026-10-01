#!/usr/bin/env node
/**
 * Built-in ACP agent for any OpenAI-compatible chat API: Google Gemini,
 * OpenRouter (Meta Llama, Mistral, DeepSeek, …), OpenAI, Groq, Together,
 * Ollama / LM Studio / vLLM on your own box.
 *
 * hive spawns it like any other ACP adapter, so API models get the same panes,
 * mail, blackboard, jobs, skills, budgets and permission policies as Claude
 * Code or Codex. It connects to the MCP servers it is handed (the hive tools)
 * and adds three file tools of its own; every tool call goes through the
 * client's permission policy first. It has no shell.
 *
 * Configured through env (agents.ts / agents.json fill these in):
 *   HIVE_API_BASE      e.g. https://generativelanguage.googleapis.com/v1beta/openai
 *   HIVE_API_KEY       the key (empty for Ollama); HIVE_API_KEY_NAME names its env var for messages
 *   HIVE_API_MODEL     default model; HIVE_API_MODELS optional comma list for the model picker
 *   HIVE_API_CONTEXT   context window in tokens (default 128000)
 *   HIVE_API_TOOLS=0   for models without function calling
 *   HIVE_API_MAX_STEPS tool rounds per prompt (default 25)
 */
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { hiveHome } from "../core/home.js";
import { confine } from "../core/confine.js";
import { withoutApiKey } from "../core/agents.js";
import { TRUST_POLICY, untrusted } from "../core/trust.js";

const env = process.env;
const BASE = (env.HIVE_API_BASE ?? "").replace(/\/+$/, "");
const KEY = env.HIVE_API_KEY ?? "";
const KEY_NAME = env.HIVE_API_KEY_NAME ?? "HIVE_API_KEY";
const LABEL = env.HIVE_API_LABEL ?? "API model";
const CONTEXT = Number(env.HIVE_API_CONTEXT) || 128_000;
const TOOLS = env.HIVE_API_TOOLS !== "0";
const MAX_STEPS = Number(env.HIVE_API_MAX_STEPS) || 25;
const MAX_READ = 200_000;

type Msg =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type ToolDef = { type: "function"; function: { name: string; description?: string; parameters: unknown } };

interface Sess {
  id: string;
  cwd: string;
  model: string;
  history: Msg[];
  mcp: { client: Client; server: string; tools: Set<string> }[];
  tools: ToolDef[];
  abort?: AbortController;
}
const sessions = new Map<string, Sess>();

// ---- models / config ----

let modelList: string[] | undefined;
async function models(): Promise<string[]> {
  if (modelList) return modelList;
  const def = env.HIVE_API_MODEL ? [env.HIVE_API_MODEL] : [];
  const fixed = (env.HIVE_API_MODELS ?? "").split(",").map((m) => m.trim()).filter(Boolean);
  let listed: string[] = [];
  if (!fixed.length && BASE) {
    try {
      const r = await fetch(`${BASE}/models`, { headers: headers(), signal: AbortSignal.timeout(4000) });
      if (r.ok) {
        const j: any = await r.json();
        listed = (j.data ?? j.models ?? []).map((m: any) => String(m.id ?? m.name ?? "").replace(/^models\//, "")).filter(Boolean);
      }
    } catch {}
  }
  modelList = [...new Set([...def, ...fixed, ...listed.sort()])].slice(0, 300);
  return modelList;
}

async function configOptions(s: Sess) {
  const list = await models();
  const all = list.includes(s.model) || !s.model ? list : [s.model, ...list];
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select" as const,
      currentValue: s.model,
      options: all.map((m) => ({ value: m, name: m })),
    },
  ];
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (KEY) h.authorization = `Bearer ${KEY}`;
  // OpenRouter shows the app name in its dashboard; harmless elsewhere.
  if (/openrouter\.ai/.test(BASE)) h["x-title"] = "hive";
  return h;
}

async function authStatus(): Promise<{ kind: string; label: string; detail?: string }> {
  if (!KEY && env.HIVE_API_KEY_NAME) return { kind: "none", label: "no API key", detail: `${KEY_NAME} not set` };
  try {
    const r = await fetch(`${BASE}/models`, { headers: headers(), signal: AbortSignal.timeout(5000) });
    if (r.status === 401 || r.status === 403) return { kind: "none", label: "key refused", detail: `the API refused ${KEY_NAME || "the request"}` };
    const host = new URL(BASE).host;
    return { kind: "api-key", label: KEY ? `API key (${KEY_NAME})` : "no key needed", detail: r.ok ? host : `${host} ${r.status}` };
  } catch (e: any) {
    return { kind: "unknown", label: `can't reach ${BASE}`, detail: String(e?.cause?.code ?? e?.message ?? e) };
  }
}

// ---- persistence (session/load, session/resume) ----

const sessDir = () => join(hiveHome(), "api-sessions");
const sessFile = (id: string) => join(sessDir(), `${id.replace(/[^\w.-]/g, "_")}.json`);
function save(s: Sess) {
  try {
    mkdirSync(sessDir(), { recursive: true });
    writeFileSync(sessFile(s.id), JSON.stringify({ cwd: s.cwd, model: s.model, history: s.history }));
  } catch {}
}
function restore(id: string): { cwd: string; model: string; history: Msg[] } | undefined {
  try {
    return JSON.parse(readFileSync(sessFile(id), "utf8"));
  } catch {
    return undefined;
  }
}

// ---- MCP (hive tools) ----

async function connectMcp(servers: acp.McpServer[]): Promise<Sess["mcp"]> {
  const out: Sess["mcp"] = [];
  for (const s of servers) {
    if (!("command" in s)) continue;
    // The hive MCP server never needs the API key.
    const e = withoutApiKey(process.env);
    for (const v of s.env) e[v.name] = v.value;
    try {
      const client = new Client({ name: "hive-api-agent", version: "0" });
      await client.connect(new StdioClientTransport({ command: s.command, args: s.args, env: e, stderr: "inherit" }));
      const t = await client.listTools();
      out.push({ client, server: s.name, tools: new Set(t.tools.map((x) => x.name)) });
    } catch (err: any) {
      process.stderr.write(`mcp ${s.name}: ${err?.message ?? err}\n`);
    }
  }
  return out;
}

const FILE_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file in the working folder. Paths are relative to it.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files and folders under a folder in the working folder (default: the root). Skips .git and node_modules.",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a text file in the working folder with the full new content. The user may be asked to approve.",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    },
  },
];

async function toolDefs(mcp: Sess["mcp"]): Promise<ToolDef[]> {
  if (!TOOLS) return [];
  const out = [...FILE_TOOLS];
  for (const m of mcp) {
    const t = await m.client.listTools();
    for (const x of t.tools) out.push({ type: "function", function: { name: x.name, description: x.description, parameters: x.inputSchema ?? { type: "object" } } });
  }
  return out;
}

function inside(cwd: string, p: string): string {
  // Follows symlinks: a link in the folder that points outside is refused.
  return confine(cwd, p || ".", p || ".");
}

function listTree(root: string, max = 400): string {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (out.length >= max || depth > 3) return;
    for (const n of readdirSync(dir).sort()) {
      if (n === ".git" || n === "node_modules" || n === ".hive") continue;
      const p = join(dir, n);
      const isDir = statSync(p).isDirectory();
      out.push(relative(root, p).split(sep).join("/") + (isDir ? "/" : ""));
      if (out.length >= max) return;
      if (isDir) walk(p, depth + 1);
    }
  };
  walk(root, 0);
  return out.join("\n") + (out.length >= max ? "\n… (truncated)" : "");
}

// ---- the model call ----

class ApiError extends Error {}

async function* stream(s: Sess, signal: AbortSignal): AsyncGenerator<any> {
  if (!BASE) throw new ApiError(`${LABEL}: no API base URL configured`);
  const body: any = { model: s.model, messages: fitContext(s.history), stream: true, stream_options: { include_usage: true } };
  if (s.tools.length) body.tools = s.tools;
  let r = await fetch(`${BASE}/chat/completions`, { method: "POST", headers: headers(), body: JSON.stringify(body), signal });
  if (r.status === 400) {
    // Some servers reject stream_options; retry once without it.
    const t = await r.text();
    if (!/stream_options/i.test(t)) throw new ApiError(`${LABEL} 400: ${t.slice(0, 600)}`);
    delete body.stream_options;
    r = await fetch(`${BASE}/chat/completions`, { method: "POST", headers: headers(), body: JSON.stringify(body), signal });
  }
  if (!r.ok) {
    const t = (await r.text()).slice(0, 600);
    if (r.status === 401 || r.status === 403) throw new ApiError(`${LABEL}: the API refused the key (${r.status}). Check ${KEY_NAME}. ${t}`);
    if (r.status === 429) throw new ApiError(`${LABEL}: usage limit / rate limit reached (429). ${t}`);
    throw new ApiError(`${LABEL} ${r.status}: ${t}`);
  }
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        yield JSON.parse(data);
      } catch {}
    }
  }
}

/** Keep the request under the context window: drop the oldest turns (never the system prompt). */
function fitContext(h: Msg[]): Msg[] {
  const budget = CONTEXT * 3; // ~chars per token, conservative
  const size = (m: Msg) => JSON.stringify(m).length;
  let total = h.reduce((n, m) => n + size(m), 0);
  if (total <= budget) return h;
  const sys = h[0]?.role === "system" ? [h[0]] : [];
  const rest = h.slice(sys.length);
  while (rest.length > 1 && total > budget) {
    total -= size(rest.shift()!);
    // Don't start on a tool result or an assistant message whose tool results were dropped.
    while (rest.length > 1 && rest[0].role !== "user") total -= size(rest.shift()!);
  }
  return [...sys, { role: "user", content: "(earlier conversation trimmed to fit the context window)" }, ...rest];
}

function systemPrompt(cwd: string): string {
  return [
    `You are an AI assistant (${LABEL}) running inside hive, a local multi-agent workspace. Working folder: ${cwd}.`,
    TOOLS
      ? "You can read, list and write files in the working folder with read_file / list_files / write_file, and talk to other agents and the human through the hive_* tools (hive_inbox, hive_send, hive_bb_set, …). You cannot run shell commands."
      : "You have no tools; answer in text.",
    TRUST_POLICY,
    "Be concise and concrete.",
  ].join("\n");
}

// ---- ACP ----

async function openSession(cx: acp.AgentContext, id: string, cwd: string, servers: acp.McpServer[], prev?: { model: string; history: Msg[] }) {
  const old = sessions.get(id);
  if (old) for (const m of old.mcp) await m.client.close().catch(() => {});
  const mcp = await connectMcp(servers);
  const s: Sess = {
    id,
    cwd,
    model: prev?.model || env.HIVE_API_MODEL || "",
    history: prev?.history?.length ? prev.history : [{ role: "system", content: systemPrompt(cwd) }],
    mcp,
    tools: await toolDefs(mcp),
  };
  if (!s.model) s.model = (await models())[0] ?? "";
  sessions.set(id, s);
  void cx;
  return s;
}

async function permit(cx: acp.AgentContext, s: Sess, id: string, title: string, kind: acp.ToolKind, rawInput: unknown, path?: string): Promise<boolean> {
  const r = await cx.request(acp.methods.client.session.requestPermission, {
    sessionId: s.id,
    toolCall: { toolCallId: id, title, kind, status: "pending", rawInput, ...(path ? { locations: [{ path }] } : {}) },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
  });
  return r.outcome.outcome === "selected" && r.outcome.optionId === "allow";
}

async function runTool(cx: acp.AgentContext, s: Sess, call: ToolCall): Promise<string> {
  let args: any = {};
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    return `error: arguments are not valid JSON: ${call.function.arguments.slice(0, 200)}`;
  }
  const name = call.function.name;
  const update = (status: "in_progress" | "completed" | "failed", text?: string) =>
    cx.notify(acp.methods.client.session.update, {
      sessionId: s.id,
      update: { sessionUpdate: "tool_call_update", toolCallId: call.id, status, ...(text ? { content: [{ type: "content", content: { type: "text", text: text.slice(0, 4000) } }] } : {}) },
    });
  try {
    if (name === "read_file" || name === "list_files" || name === "write_file") {
      const abs = inside(s.cwd, String(args.path ?? ""));
      const rel = relative(confine(s.cwd, "."), abs) || ".";
      const kind: acp.ToolKind = name === "write_file" ? "edit" : name === "read_file" ? "read" : "search";
      const title = name === "write_file" ? `Write ${rel}` : name === "read_file" ? `Read ${rel}` : `List ${rel}`;
      await cx.notify(acp.methods.client.session.update, {
        sessionId: s.id,
        update: { sessionUpdate: "tool_call", toolCallId: call.id, title, kind, status: "pending", locations: [{ path: abs }], rawInput: args },
      });
      if (!(await permit(cx, s, call.id, title, kind, args, abs))) {
        await update("failed", "rejected by the user / policy");
        return "error: the user (or the permission policy) rejected this. Don't retry it; continue without it or ask.";
      }
      await update("in_progress");
      let out: string;
      if (name === "read_file") {
        if (statSync(abs).size > MAX_READ) throw new Error(`${rel} is larger than ${MAX_READ / 1000} KB`);
        out = untrusted(`contents of ${rel}`, await readFile(abs, "utf8"));
      } else if (name === "list_files") out = listTree(abs) || "(empty)";
      else {
        const content = String(args.content ?? "");
        const before = existsSync(abs) ? await readFile(abs, "utf8").catch(() => null) : null;
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content, "utf8");
        await cx.notify(acp.methods.client.session.update, {
          sessionId: s.id,
          update: { sessionUpdate: "tool_call_update", toolCallId: call.id, content: [{ type: "diff", path: abs, oldText: before, newText: content }] },
        });
        out = `wrote ${rel} (${content.length} chars)`;
      }
      await update("completed", name === "read_file" ? `${out.length} chars` : out);
      return out;
    }
    const m = s.mcp.find((x) => x.tools.has(name));
    if (!m) return `error: no tool named ${name}`;
    const title = `mcp__${m.server}__${name}`;
    await cx.notify(acp.methods.client.session.update, {
      sessionId: s.id,
      update: { sessionUpdate: "tool_call", toolCallId: call.id, title, kind: "other", status: "pending", rawInput: args },
    });
    if (!(await permit(cx, s, call.id, title, "other", { tool: name, ...args }))) {
      await update("failed", "rejected by the user / policy");
      return "error: the user (or the permission policy) rejected this tool call.";
    }
    const r = await m.client.callTool({ name, arguments: args });
    const text = ((r.content as any[]) ?? []).map((c) => (c.type === "text" ? c.text : JSON.stringify(c))).join("\n");
    await update(r.isError ? "failed" : "completed", text);
    return text || "(no output)";
  } catch (e: any) {
    await update("failed", String(e?.message ?? e));
    return `error: ${e?.message ?? e}`;
  }
}

function promptText(blocks: acp.ContentBlock[]): string {
  return blocks
    .map((b: any) => {
      if (b.type === "text") return b.text;
      if (b.type === "resource" && typeof b.resource?.text === "string") return `(file ${b.resource.uri})\n${b.resource.text}`;
      if (b.type === "resource_link") return `(file ${b.uri})`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

let n = 0;
acp
  .agent({ name: "hive-api-agent" })
  .onRequest("initialize", async (ctx) => {
    // Like the vendor adapters: push who we are (here: is the key set / accepted).
    setTimeout(() => void authStatus().then((authStatus) => ctx.client.notify("_auth/status_update", { authStatus })).catch(() => {}), 10);
    return {
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { embeddedContext: true },
      mcpCapabilities: { http: false, sse: false },
      sessionCapabilities: { close: {}, resume: {} },
      _meta: { authStatus: {} },
    },
    agentInfo: { name: "hive-api-agent", title: LABEL, version: "0.1.0" },
    };
  })
  .onRequest("authenticate", async () => ({}))
  .onRequest("session/new", async (ctx) => {
    const id = `api-${Date.now().toString(36)}-${++n}`;
    const s = await openSession(ctx.client, id, ctx.params.cwd, ctx.params.mcpServers ?? []);
    save(s);
    return { sessionId: id, configOptions: await configOptions(s) };
  })
  .onRequest("session/resume", async (ctx) => {
    const prev = restore(ctx.params.sessionId);
    if (!prev) throw acp.RequestError.resourceNotFound(ctx.params.sessionId);
    const s = await openSession(ctx.client, ctx.params.sessionId, ctx.params.cwd, ctx.params.mcpServers ?? [], prev);
    return { configOptions: await configOptions(s) };
  })
  .onRequest("session/load", async (ctx) => {
    const prev = restore(ctx.params.sessionId);
    if (!prev) throw acp.RequestError.resourceNotFound(ctx.params.sessionId);
    const s = await openSession(ctx.client, ctx.params.sessionId, ctx.params.cwd, ctx.params.mcpServers ?? [], prev);
    for (const m of s.history) {
      if (m.role === "user" && !m.content.startsWith("(earlier"))
        await ctx.client.notify(acp.methods.client.session.update, { sessionId: s.id, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: m.content } } });
      if (m.role === "assistant" && m.content)
        await ctx.client.notify(acp.methods.client.session.update, { sessionId: s.id, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: m.content } } });
    }
    return { configOptions: await configOptions(s) };
  })
  .onRequest("session/close", async (ctx) => {
    const s = sessions.get(ctx.params.sessionId);
    if (s) for (const m of s.mcp) await m.client.close().catch(() => {});
    sessions.delete(ctx.params.sessionId);
    return {};
  })
  .onRequest("session/set_config_option", async (ctx) => {
    const p = ctx.params as any;
    const s = sessions.get(p.sessionId);
    if (!s) throw acp.RequestError.resourceNotFound(p.sessionId);
    if (p.configId === "model") {
      s.model = String(p.value);
      save(s);
    }
    return { configOptions: await configOptions(s) };
  })
  .onRequest("session/set_mode", async () => ({}))
  .onRequest("session/prompt", async (ctx) => {
    const s = sessions.get(ctx.params.sessionId);
    if (!s) throw acp.RequestError.resourceNotFound(ctx.params.sessionId);
    const cx = ctx.client;
    if (!s.model) throw new Error(`${LABEL}: no model chosen (set HIVE_API_MODEL or pick one in the pane)`);
    if (!KEY && env.HIVE_API_KEY_NAME) throw new Error(`${LABEL}: ${KEY_NAME} is not set`);
    s.history.push({ role: "user", content: promptText(ctx.params.prompt) });
    s.abort = new AbortController();
    const usage = { totalTokens: 0, inputTokens: 0, outputTokens: 0 };
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        let text = "";
        const calls: ToolCall[] = [];
        let finish = "";
        let chunk: any;
        for await (chunk of stream(s, s.abort.signal)) {
          if (chunk.error) throw new ApiError(`${LABEL}: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);
          if (chunk.usage) {
            usage.inputTokens += chunk.usage.prompt_tokens ?? 0;
            usage.outputTokens += chunk.usage.completion_tokens ?? 0;
            usage.totalTokens += chunk.usage.total_tokens ?? (chunk.usage.prompt_tokens ?? 0) + (chunk.usage.completion_tokens ?? 0);
            await cx.notify(acp.methods.client.session.update, {
              sessionId: s.id,
              update: { sessionUpdate: "usage_update", used: chunk.usage.total_tokens ?? 0, size: CONTEXT } as any,
            });
          }
          const c: any = chunk.choices?.[0];
          if (!c) continue;
          const d: any = c.delta ?? {};
          const thought = d.reasoning_content ?? d.reasoning;
          if (typeof thought === "string" && thought)
            await cx.notify(acp.methods.client.session.update, { sessionId: s.id, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: thought } } });
          if (typeof d.content === "string" && d.content) {
            text += d.content;
            await cx.notify(acp.methods.client.session.update, { sessionId: s.id, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: d.content } } });
          }
          for (const tc of (d.tool_calls ?? []) as any[]) {
            const i = tc.index ?? calls.length;
            calls[i] ??= { id: "", type: "function", function: { name: "", arguments: "" } };
            if (tc.id) calls[i].id = tc.id;
            if (tc.function?.name) calls[i].function.name += tc.function.name;
            if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
          }
          if (c.finish_reason) finish = c.finish_reason;
        }
        const real = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${Date.now().toString(36)}_${i}` }));
        s.history.push({ role: "assistant", content: text || null, ...(real.length ? { tool_calls: real } : {}) });
        if (!real.length) {
          save(s);
          return { stopReason: finish === "length" ? "max_tokens" : "end_turn", usage };
        }
        for (const call of real) {
          // Every tool call needs a result, or the next request is invalid.
          const out = s.abort.signal.aborted ? "cancelled by the user" : await runTool(cx, s, call);
          s.history.push({ role: "tool", tool_call_id: call.id, content: out });
        }
        save(s);
        if (s.abort.signal.aborted) return { stopReason: "cancelled", usage };
      }
      await cx.notify(acp.methods.client.session.update, {
        sessionId: s.id,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n(stopped after ${MAX_STEPS} tool rounds)` } },
      });
      save(s);
      return { stopReason: "max_turn_requests", usage };
    } catch (e: any) {
      if (s.abort.signal.aborted || e?.name === "AbortError") {
        save(s);
        return { stopReason: "cancelled", usage };
      }
      // Leave the history consistent: an unanswered user turn is fine, a dangling tool call isn't.
      const last = s.history.at(-1);
      if (last?.role === "assistant" && last.tool_calls?.length) s.history.pop();
      save(s);
      throw new Error(String(e?.message ?? e));
    } finally {
      s.abort = undefined;
    }
  })
  .onNotification("session/cancel", async (ctx) => {
    sessions.get(ctx.params.sessionId)?.abort?.abort();
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));

process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
