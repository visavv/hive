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
}

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const mockEntry = nodeEntry("mock/agent");

export const AGENTS: Record<string, AgentDef> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    command: npx,
    args: ["-y", "@agentclientprotocol/claude-agent-acp"],
    install:
      "Auth via `claude login` (Max/Pro) or ANTHROPIC_API_KEY. Uses the Claude Agent SDK under the hood.",
  },
  codex: {
    id: "codex",
    label: "Codex",
    command: npx,
    args: ["-y", "@agentclientprotocol/codex-acp"],
    install:
      "Auth via `codex login` (ChatGPT subscription) or OPENAI_API_KEY. Wraps the Codex App Server.",
  },
  qwen: {
    id: "qwen",
    label: "Qwen Code (local)",
    command: "qwen",
    args: ["--acp"],
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
    install:
      "Install opencode; configure providers in ~/.config/opencode/opencode.json. Good home for API-key models.",
  },
  gemini: {
    id: "gemini",
    label: "Gemini CLI",
    command: "gemini",
    args: ["--experimental-acp"],
    install: "npm i -g @google/gemini-cli; `gemini` once to auth.",
  },
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

/** Expand ${VAR} references against process.env; drop unset vars. */
export function resolveEnv(def: AgentDef): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(def.env ?? {})) {
    const expanded = v.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "");
    if (expanded) out[k] = expanded;
  }
  return out;
}

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
export function killTree(proc: ChildProcess | undefined) {
  if (!proc || proc.exitCode !== null || proc.pid == null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true });
  } else {
    proc.kill();
  }
}
