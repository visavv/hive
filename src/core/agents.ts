/**
 * Agent definitions: how to launch each vendor's ACP endpoint.
 *
 * Every entry spawns a subprocess that speaks ACP (JSON-RPC over stdio).
 * Subscriptions (Claude Max, ChatGPT/Codex) flow through the vendor's own
 * binary, so auth, sandboxing and permission prompts are the vendor's.
 *
 * Add a new vendor by adding an entry; nothing else in the hub changes.
 */
import { nodeEntry } from "./paths.js";
import { spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hiveHome } from "./home.js";
import { validateMcpRefs, type McpRef } from "./mcp-extra.js";

export interface AgentDef {
  /** Short id used in config and hive addressing, e.g. "claude". */
  id: string;
  /** Human label. */
  label: string;
  /** Executable (resolved via PATH) or absolute path. */
  command: string;
  args: string[];
  /** Extra env for the subprocess. Values may reference ${VAR}. */
  env?: Record<string, string>;
  /** Notes on install/auth for the README and `hive doctor`. */
  install: string;
  /** Env var that must be set for this agent to work (doctor / UI hint). */
  needs?: string;
  /** How to sign in, shown in the Accounts view (subscription CLIs log in once on this machine). */
  login?: string;
  /** Built-in API agent (api/agent.ts) rather than a vendor CLI. */
  api?: boolean;
  /** Came from <HIVE_HOME>/agents.json. */
  custom?: boolean;
  /** Extra MCP servers every agent of this type gets (agents.json "mcp"; see mcp-extra.ts). */
  mcp?: McpRef[];
}

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const require = createRequire(import.meta.url);

/**
 * Run an ACP adapter from our own node_modules (version pinned in
 * package.json, no network on spawn, no shell on Windows); fall back to npx
 * only if it isn't installed.
 */
function pinned(pkg: string): { command: string; args: string[] } {
  try {
    const pj = require.resolve(`${pkg}/package.json`);
    const meta = JSON.parse(readFileSync(pj, "utf8")) as { bin?: string | Record<string, string> };
    const bin = typeof meta.bin === "string" ? meta.bin : Object.values(meta.bin ?? {})[0];
    if (bin) return { command: process.execPath, args: [join(dirname(pj), bin)] };
  } catch {}
  return { command: npx, args: ["-y", pkg] };
}
const claudeAcp = pinned("@agentclientprotocol/claude-agent-acp");
const codexAcp = pinned("@agentclientprotocol/codex-acp");
const mockEntry = nodeEntry("mock/agent");
const apiEntry = nodeEntry("api/agent");

/** An agent backed by any OpenAI-compatible chat API (see api/agent.ts). */
export function apiAgent(o: { id: string; label: string; base: string; keyEnv?: string; model: string; models?: string; context?: number; tools?: boolean; install?: string; login?: string; custom?: boolean }): AgentDef {
  return {
    id: o.id,
    label: o.label,
    ...apiEntry,
    api: true,
    custom: o.custom,
    needs: o.keyEnv,
    env: {
      HIVE_API_BASE: o.base,
      HIVE_API_KEY: o.keyEnv ? `\${${o.keyEnv}}` : "",
      HIVE_API_KEY_NAME: o.keyEnv ?? "",
      HIVE_API_MODEL: o.model,
      HIVE_API_MODELS: o.models ?? "",
      HIVE_API_LABEL: o.label,
      HIVE_API_CONTEXT: o.context ? String(o.context) : "",
      HIVE_API_TOOLS: o.tools === false ? "0" : "",
    },
    login: o.login ?? (o.keyEnv ? `Set ${o.keyEnv} in your environment (Windows: setx ${o.keyEnv} "…" then reopen; Linux: export it in ~/.bashrc or ~/.config/environment.d/).` : "No key needed."),
    install: o.install ?? `Set ${o.keyEnv ?? "nothing (no key needed)"}. Talks to ${o.base} directly; pick the model in the pane.`,
  };
}

export const AGENTS: Record<string, AgentDef> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    ...claudeAcp,
    login: "Run `claude` in a terminal and type /login (Claude Pro/Max), or set ANTHROPIC_API_KEY.",
    install:
      "Auth via `claude login` (Max/Pro) or ANTHROPIC_API_KEY. Uses the Claude Agent SDK under the hood.",
  },
  codex: {
    id: "codex",
    label: "Codex",
    ...codexAcp,
    login: "Run `codex login` (ChatGPT Plus/Pro/Business), or `codex login --device-auth` on a machine without a browser.",
    install:
      "Auth via `codex login` (ChatGPT subscription) or OPENAI_API_KEY. Wraps the Codex App Server.",
  },
  qwen: {
    id: "qwen",
    label: "Qwen Code (local)",
    command: "qwen",
    args: ["--acp"],
    login: "Run `qwen` once and sign in, or set QWEN_BASE_URL / QWEN_MODEL / QWEN_API_KEY for a local server.",
    env: {
      // Point at the T550 / any OpenAI-compatible endpoint (Ollama, vLLM, llama.cpp).
      OPENAI_BASE_URL: "${QWEN_BASE_URL}",
      OPENAI_API_KEY: "${QWEN_API_KEY}",
      OPENAI_MODEL: "${QWEN_MODEL}",
    },
    install:
      "npm i -g @qwen-code/qwen-code. Set QWEN_BASE_URL (e.g. http://192.168.10.69:11434/v1), QWEN_MODEL, QWEN_API_KEY (any string for Ollama).",
  },
  opencode: {
    id: "opencode",
    label: "OpenCode (any provider: DeepSeek, GLM, OpenRouter, local)",
    command: "opencode",
    args: ["acp"],
    login: "Run `opencode auth login` and pick a provider.",
    install:
      "Install opencode; configure providers in ~/.config/opencode/opencode.json. Good home for API-key models.",
  },
  gemini: {
    id: "gemini",
    label: "Gemini CLI",
    command: "gemini",
    args: ["--experimental-acp"],
    login: "Run `gemini` once and choose “Login with Google”, or set GEMINI_API_KEY.",
    install: "npm i -g @google/gemini-cli; `gemini` once to auth.",
  },
  // ---- API models (pay per token with your own keys; no CLI to install) ----
  "gemini-api": apiAgent({
    id: "gemini-api",
    label: "Google Gemini (API)",
    base: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEnv: "GEMINI_API_KEY",
    model: "${GEMINI_MODEL:-gemini-2.5-flash}",
    context: 1_000_000,
    install: "Get a key at https://aistudio.google.com/apikey and set GEMINI_API_KEY (free tier available). GEMINI_MODEL picks the default model.",
  }),
  openrouter: apiAgent({
    id: "openrouter",
    label: "OpenRouter (Meta Llama, Mistral, DeepSeek, …)",
    base: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    model: "${OPENROUTER_MODEL:-meta-llama/llama-4-maverick}",
    install: "Key at https://openrouter.ai/keys → OPENROUTER_API_KEY. One key for hundreds of models (Meta Llama, Mistral, Qwen, DeepSeek, Gemini, GPT…); pick in the pane or set OPENROUTER_MODEL.",
  }),
  "openai-api": apiAgent({
    id: "openai-api",
    label: "OpenAI (API)",
    base: "${OPENAI_BASE_URL:-https://api.openai.com/v1}",
    keyEnv: "OPENAI_API_KEY",
    model: "${OPENAI_MODEL:-gpt-4.1-mini}",
    install: "OPENAI_API_KEY (platform.openai.com, billed per token — separate from a ChatGPT subscription; use `codex` for that). OPENAI_MODEL picks the default.",
  }),
  "meta-llama": apiAgent({
    id: "meta-llama",
    label: "Meta Llama API",
    base: "${LLAMA_API_BASE:-https://api.llama.com/compat/v1}",
    keyEnv: "LLAMA_API_KEY",
    model: "${LLAMA_MODEL:-Llama-4-Maverick-17B-128E-Instruct-FP8}",
    install: "Key from Meta's Llama API developer console → LLAMA_API_KEY. If Meta changes the endpoint or model names, set LLAMA_API_BASE / LLAMA_MODEL (or use openrouter for Meta models).",
  }),
  ollama: apiAgent({
    id: "ollama",
    label: "Ollama (local / T550)",
    base: "${OLLAMA_BASE_URL:-http://localhost:11434/v1}",
    model: "${OLLAMA_MODEL:-llama3.1}",
    login: "No key. Start Ollama here (`ollama serve`) or point OLLAMA_BASE_URL at the T550 (http://<ip>:11434/v1).",
    context: 32_000,
    install: "Run Ollama (ollama.com) here or on the T550; set OLLAMA_BASE_URL=http://<host>:11434/v1 and OLLAMA_MODEL. No key. Use a model with tool support (llama3.1, qwen2.5, qwen3…).",
  }),
  mock: {
    id: "mock",
    label: "Mock agent (tests)",
    // Run with the current node binary (no npx) so tests are fast and paths
    // stay valid on Windows (a file URL's .pathname is "/C:/..." there).
    command: mockEntry.command,
    args: mockEntry.args,
    install: "Built in. No auth. Echoes prompts and exercises hive tools.",
  },
};

/** Expand ${VAR} and ${VAR:-default} against process.env. */
export function expandVars(v: string, e: NodeJS.ProcessEnv = process.env): string {
  return v.replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_, name, def) => e[name] || def || "");
}

/** Resolved env for an agent's subprocess; unset vars are dropped. */
export function resolveEnv(def: AgentDef, e: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(def.env ?? {})) {
    const expanded = expandVars(v, e);
    if (expanded) out[k] = expanded;
  }
  // An API agent must not pick up a stale HIVE_API_* from the parent env.
  if (def.api) for (const k of Object.keys(def.env ?? {})) out[k] ??= "";
  return out;
}

// ---- secrets an agent process must not see ----
/** Bridge tokens and media keys: only the hive process uses them. */
const SECRET_PREFIXES = ["HIVE_DISCORD_", "HIVE_WHATSAPP_", "HIVE_IMAGE_", "ELEVENLABS_", "TWITCH_CLIENT_SECRET", "HIVE_VISION_KEY"];
/** Provider keys (plus every API agent's keyEnv, added at call time). */
const PROVIDER_KEYS = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "AZURE_OPENAI_API_KEY",
  "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "OPENROUTER_API_KEY", "LLAMA_API_KEY", "QWEN_API_KEY", "DASHSCOPE_API_KEY",
  "GROQ_API_KEY", "MISTRAL_API_KEY", "DEEPSEEK_API_KEY", "XAI_API_KEY", "TOGETHER_API_KEY", "FIREWORKS_API_KEY", "COHERE_API_KEY",
  "PERPLEXITY_API_KEY", "CEREBRAS_API_KEY", "MOONSHOT_API_KEY", "ZHIPU_API_KEY", "ZAI_API_KEY", "HF_TOKEN", "HUGGINGFACE_API_KEY", "HIVE_API_KEY",
];
/** A vendor CLI keeps its own provider's variables. */
const VENDOR_KEEP: Record<string, string[]> = { claude: ["ANTHROPIC_", "CLAUDE_"], codex: ["OPENAI_", "CODEX_"], gemini: ["GEMINI_", "GOOGLE_"], qwen: ["QWEN_", "DASHSCOPE_"] };

/**
 * Environment for an agent's subprocess: the parent env minus bridge tokens,
 * media keys and other providers' keys, plus the agent's own resolved env.
 * Kept: what the agent names (needs, ${VAR} in its env) and its vendor's own variables.
 */
export function agentEnv(def: AgentDef, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = new Set([def.needs, ...[...JSON.stringify(def.env ?? {}).matchAll(/\$\{(\w+)/g)].map((m) => m[1])].filter(Boolean).map((k) => k!.toUpperCase()));
  const vendor = VENDOR_KEEP[def.id] ?? [];
  // OpenCode is the home for API-key models: it reads providers' keys itself.
  const keys = def.id === "opencode" ? new Set<string>() : new Set([...PROVIDER_KEYS, ...Object.values(AGENTS).map((a) => a.needs?.toUpperCase())]);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    const K = k.toUpperCase();
    const secret = SECRET_PREFIXES.some((p) => K.startsWith(p)) || keys.has(K);
    if (!secret || keep.has(K) || vendor.some((p) => K.startsWith(p))) out[k] = v;
  }
  return { ...out, ...resolveEnv(def, base) };
}

/** An API agent's env for its MCP children: without its key (HIVE_API_KEY and the variable it came from). */
export function withoutApiKey(base: NodeJS.ProcessEnv): Record<string, string> {
  const key = base.HIVE_API_KEY;
  const drop = new Set(["HIVE_API_KEY", base.HIVE_API_KEY_NAME ?? ""]);
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !drop.has(k) && !(key && v === key)) e[k] = v;
  return e;
}

// ---- custom agents: <HIVE_HOME>/agents.json ----
//
// {
//   "groq":   { "type": "api", "label": "Groq", "base": "https://api.groq.com/openai/v1", "keyEnv": "GROQ_API_KEY", "model": "llama-3.3-70b-versatile" },
//   "mistral":{ "type": "api", "base": "https://api.mistral.ai/v1", "keyEnv": "MISTRAL_API_KEY", "model": "mistral-large-latest" },
//   "aider":  { "type": "acp", "label": "Some ACP agent", "command": "some-agent", "args": ["--acp"] }
// }
// Keys never go in this file — only the name of the env var that holds them.

export interface CustomAgent {
  type: "api" | "acp";
  label?: string;
  base?: string;
  keyEnv?: string;
  model?: string;
  models?: string[];
  context?: number;
  tools?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Extra MCP servers: inline {name, command, args, env?} or names from mcp.json (mcp-extra.ts). */
  mcp?: McpRef[];
}

export function customAgentsPath(): string {
  return join(hiveHome(), "agents.json");
}

export function readCustomAgents(path = customAgentsPath()): Record<string, CustomAgent> {
  if (!existsSync(path)) return {};
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    return j && typeof j === "object" ? j : {};
  } catch (e: any) {
    process.stderr.write(`hive: ignoring ${path}: ${e.message}\n`);
    return {};
  }
}

export function customAgentDef(id: string, c: CustomAgent): AgentDef {
  const mcp = validateMcpRefs(c.mcp, `agent ${id}`);
  const def = customAgentBase(id, c);
  return mcp.length ? { ...def, mcp } : def;
}

function customAgentBase(id: string, c: CustomAgent): AgentDef {
  if (!/^[\w.-]{1,40}$/.test(id)) throw new Error(`agent id "${id}": letters, digits, _ . - only`);
  if (c.type === "acp") {
    if (!c.command) throw new Error(`agent ${id}: "command" is required for type acp`);
    return { id, label: c.label ?? id, command: c.command, args: c.args ?? [], env: c.env, install: "Custom ACP agent from agents.json.", custom: true };
  }
  if (!c.base || !c.model) throw new Error(`agent ${id}: "base" and "model" are required for type api`);
  if (!/\$\{/.test(c.base)) {
    let u: URL | undefined;
    try {
      u = new URL(c.base);
    } catch {}
    if (!u || (u.protocol !== "https:" && u.protocol !== "http:")) throw new Error(`agent ${id}: base must be an http(s) URL like https://api.example.com/v1 (got "${c.base}")`);
  }
  if (c.keyEnv && !/^\w+$/.test(c.keyEnv)) throw new Error(`agent ${id}: keyEnv must be an environment variable name, not the key itself`);
  return apiAgent({ id, label: c.label ?? id, base: c.base, keyEnv: c.keyEnv, model: c.model, models: c.models?.join(","), context: c.context, tools: c.tools, custom: true });
}

export function saveCustomAgent(id: string, c: CustomAgent | null, path = customAgentsPath()) {
  const all = readCustomAgents(path);
  if (c) {
    customAgentDef(id, c); // validate
    all[id] = c;
  } else delete all[id];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(all, null, 2) + "\n");
}

/** Merge agents.json into AGENTS (built-ins keep their ids). */
export function loadCustomAgents(path = customAgentsPath()): string[] {
  const added: string[] = [];
  for (const [id, c] of Object.entries(readCustomAgents(path))) {
    if (AGENTS[id] && !AGENTS[id].custom) {
      // { "claude": { "mcp": [...] } } attaches MCP servers to a built-in type.
      if (c?.mcp !== undefined)
        try {
          const mcp = validateMcpRefs(c.mcp, `agent ${id}`);
          if (mcp.length) AGENTS[id] = { ...AGENTS[id], mcp };
        } catch (e: any) {
          process.stderr.write(`hive: agents.json: ${e.message}\n`);
        }
      continue;
    }
    try {
      AGENTS[id] = customAgentDef(id, c);
      added.push(id);
    } catch (e: any) {
      process.stderr.write(`hive: agents.json: ${e.message}\n`);
    }
  }
  return added;
}
loadCustomAgents();

/**
 * How to spawn an agent. On Windows, `npx.cmd` and other .cmd shims need a
 * shell (Node refuses to spawn .cmd/.bat directly since CVE-2024-27980), and
 * with `shell: true` Node joins args with spaces without quoting, so quote
 * them ourselves for cmd.exe.
 */
export function spawnSpec(def: AgentDef, platform = process.platform): { command: string; args: string[]; shell: boolean } {
  if (platform !== "win32") return { command: def.command, args: def.args, shell: false };
  const needsShell = /\.(cmd|bat)$/i.test(def.command) || !/[\\/]/.test(def.command);
  if (!needsShell) return { command: def.command, args: def.args, shell: false };
  return { command: winQuote(def.command), args: def.args.map(winQuote), shell: true };
}

/** Quote one argument for cmd.exe. */
export function winQuote(a: string): string {
  if (a !== "" && !/[\s"&|<>^()%!]/.test(a)) return a;
  return `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/**
 * Stop an agent and everything it spawned. On Windows a shell-launched
 * adapter is cmd.exe → npx → node → claude; kill() would only end cmd.exe.
 */
export async function killTree(proc: ChildProcess | undefined, graceMs = 3000): Promise<void> {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null || proc.pid == null) return;
  const exited = new Promise<void>((r) => proc.once("exit", () => r()));
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true });
    await Promise.race([exited, new Promise((r) => setTimeout(r, graceMs))]);
    return;
  }
  // Agents are spawned as process-group leaders (groupSpawn): signal the group.
  const pid = proc.pid;
  killGroup(pid, "SIGTERM") || proc.kill();
  const t = await Promise.race([exited.then(() => "exited"), new Promise((r) => setTimeout(() => r("timeout"), graceMs))]);
  // Anything that ignored SIGTERM (or children left in the group) goes now.
  killGroup(pid, "SIGKILL");
  if (t === "timeout") await Promise.race([exited, new Promise((r) => setTimeout(r, 500))]);
}

/** Signal a whole process group (POSIX). Returns false if there is none. */
export function killGroup(pid: number, sig: NodeJS.Signals): boolean {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    return true;
  }
  try {
    process.kill(-pid, sig);
    return true;
  } catch {
    return false;
  }
}

/** Spawn options that let killTree reach everything an agent starts. */
export const groupSpawn = process.platform === "win32" ? {} : { detached: true };
