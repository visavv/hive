/**
 * Extra MCP servers for agents (DaVinci Resolve, a database, a browser…), on
 * top of the `hive` server every agent gets.
 *
 *   <HIVE_HOME>/mcp.json — named servers you can attach to any agent:
 *     { "davinci": { "command": "uv", "args": ["--directory", "C:/mcp/davinci-resolve-mcp", "run", "resolve_mcp_server.py"] },
 *       "pg":      { "command": "npx", "args": ["-y", "some-postgres-mcp"], "env": { "DATABASE_URL": "${PG_URL}" } } }
 *
 *   <HIVE_HOME>/agents.json — per agent type, an `mcp` array (inline entries or names from mcp.json):
 *     { "editor": { "type": "acp", "command": "…", "mcp": ["davinci"] },
 *       "claude": { "mcp": [{ "name": "pg", "command": "…", "args": [] }] } }   ← adds to a built-in type
 *
 *   Per agent: `--mcp davinci` on the CLI, or the checkboxes in the Add-agent dialog.
 *
 * Secrets: hive passes a server only the env its entry names. `${VAR}` in an
 * entry's env is filled from hive's environment; nothing else from hive's env
 * is added. (The agent CLI that spawns the server may hand it its own
 * environment as well; hive already strips other providers' keys, bridge
 * tokens and media keys from that — see agentEnv in agents.ts.)
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { hiveHome } from "./home.js";

/** ${VAR} / ${VAR:-default} (same rules as agents.ts; kept here so agents.ts can import this file). */
const expandVars = (v: string, e: NodeJS.ProcessEnv) => v.replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_, n, def) => e[n] || def || "");

export interface McpEntry {
  name: string;
  command: string;
  args?: string[];
  /** Env for the server; values may reference ${VAR} / ${VAR:-default} from hive's environment. */
  env?: Record<string, string>;
}

/** What ACP's session/new takes for a stdio MCP server. */
export interface AcpStdioServer {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
}

const NAME = /^[A-Za-z0-9][\w.-]{0,39}$/;

export function mcpConfigPath(): string {
  return join(hiveHome(), "mcp.json");
}

/** Why `name` can't be an MCP server name, or undefined. */
export function mcpNameProblem(name: string): string | undefined {
  if (!NAME.test(name)) return "use letters, digits, _ . - (max 40, starting with a letter or digit)";
  if (name.toLowerCase() === "hive") return '"hive" is hive\'s own server';
  return undefined;
}

/** Check one entry; returns it normalized (args/env copied) or throws. */
export function validateMcpEntry(e: unknown, where = "mcp"): McpEntry {
  const x = e as Partial<McpEntry> | null;
  if (!x || typeof x !== "object") throw new Error(`${where}: an MCP server entry must be an object`);
  const name = String(x.name ?? "");
  const bad = mcpNameProblem(name);
  if (bad) throw new Error(`${where}: server name "${name}": ${bad}`);
  if (typeof x.command !== "string" || !x.command.trim()) throw new Error(`${where}: server "${name}" needs a "command"`);
  if (x.args !== undefined && (!Array.isArray(x.args) || x.args.some((a) => typeof a !== "string"))) throw new Error(`${where}: server "${name}": "args" must be a list of strings`);
  const env: Record<string, string> = {};
  if (x.env !== undefined) {
    if (!x.env || typeof x.env !== "object" || Array.isArray(x.env)) throw new Error(`${where}: server "${name}": "env" must be an object`);
    for (const [k, v] of Object.entries(x.env)) {
      if (!/^[A-Za-z_]\w*$/.test(k)) throw new Error(`${where}: server "${name}": env name "${k}" is not a variable name`);
      if (typeof v !== "string") throw new Error(`${where}: server "${name}": env ${k} must be a string`);
      env[k] = v;
    }
  }
  return { name, command: x.command, args: [...(x.args ?? [])], ...(x.env ? { env } : {}) };
}

/** Parsed mcp.json by path + mtime: the UI reads it every second, warnings print once per edit. */
const cache = new Map<string, { mtime: number; servers: Record<string, McpEntry> }>();

/** Named servers from mcp.json (invalid entries are skipped with a warning). */
export function readMcpConfig(path = mcpConfigPath()): Record<string, McpEntry> {
  if (!existsSync(path)) return {};
  let mtime = 0;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {}
  const hit = cache.get(path);
  if (hit && hit.mtime === mtime) return hit.servers;
  const servers = parseMcpConfig(path);
  cache.set(path, { mtime, servers });
  return servers;
}

function parseMcpConfig(path: string): Record<string, McpEntry> {
  let j: any;
  try {
    j = JSON.parse(readFileSync(path, "utf8"));
  } catch (e: any) {
    process.stderr.write(`hive: ignoring ${path}: ${e.message}\n`);
    return {};
  }
  const out: Record<string, McpEntry> = {};
  if (!j || typeof j !== "object" || Array.isArray(j)) return out;
  for (const [name, v] of Object.entries(j)) {
    try {
      out[name] = validateMcpEntry({ ...(v as object), name }, "mcp.json");
    } catch (e: any) {
      process.stderr.write(`hive: ${e.message}\n`);
    }
  }
  return out;
}

/**
 * The `mcp` field of an agents.json entry: inline entries, or names that refer
 * to mcp.json (resolved when the agent starts, so editing mcp.json applies).
 */
export type McpRef = McpEntry | string;

export function validateMcpRefs(refs: unknown, where: string): McpRef[] {
  if (refs === undefined) return [];
  if (!Array.isArray(refs)) throw new Error(`${where}: "mcp" must be a list`);
  return refs.map((r) => {
    if (typeof r === "string") {
      const bad = mcpNameProblem(r);
      if (bad) throw new Error(`${where}: MCP server name "${r}": ${bad}`);
      return r;
    }
    return validateMcpEntry(r, where);
  });
}

/** Normalize a list of names (CLI --mcp a,b / dialog checkboxes). Throws on a bad name. */
export function parseMcpNames(v: string | string[] | undefined): string[] {
  const list = (Array.isArray(v) ? v : v ? [v] : []).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
  for (const n of list) {
    const bad = mcpNameProblem(n);
    if (bad) throw new Error(`MCP server name "${n}": ${bad}`);
  }
  return [...new Set(list)];
}

/**
 * Servers for one agent: its type's `mcp` refs plus the agent's own names,
 * resolved against mcp.json. Unknown names throw (a typo should not silently
 * start an agent without its tools). Later duplicates of a name are dropped.
 */
export function resolveMcpServers(typeRefs: McpRef[] = [], names: string[] = [], config = readMcpConfig(), env: NodeJS.ProcessEnv = process.env): AcpStdioServer[] {
  const out: AcpStdioServer[] = [];
  const seen = new Set<string>(["hive"]);
  for (const r of [...typeRefs, ...names]) {
    const e = typeof r === "string" ? config[r] : r;
    if (!e) throw new Error(`MCP server "${r}" is not defined in ${mcpConfigPath()}`);
    if (seen.has(e.name)) continue;
    seen.add(e.name);
    out.push({
      name: e.name,
      command: expandVars(e.command, env),
      args: (e.args ?? []).map((a) => expandVars(a, env)),
      // Only what the entry names; unset ${VAR}s become "" and are dropped.
      env: Object.entries(e.env ?? {})
        .map(([name, v]) => ({ name, value: expandVars(v, env) }))
        .filter((x) => x.value !== ""),
    });
  }
  return out;
}

/** Names of the servers configured in mcp.json, for the Add-agent dialog. */
export function mcpServerList(config = readMcpConfig()): { name: string; command: string }[] {
  return Object.values(config).map((e) => ({ name: e.name, command: [e.command, ...(e.args ?? [])].join(" ").slice(0, 120) }));
}

// ---- per-agent attachments, remembered so wake-ups and restarts get the same servers ----

interface SettingsDb {
  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string | null): void;
}
const KEY = (agent: string) => `agent_mcp.${agent}`;

export function storedMcp(db: SettingsDb, agent: string): string[] {
  const v = db.getSetting(KEY(agent));
  return v ? v.split(",").filter(Boolean) : [];
}
export function storeMcp(db: SettingsDb, agent: string, names: string[]) {
  db.setSetting(KEY(agent), names.length ? names.join(",") : null);
}
