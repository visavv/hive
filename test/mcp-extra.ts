/** Extra MCP servers per agent type (agents.json "mcp") and per agent (mcp.json + --mcp / Add-agent dialog). */
import { join, resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { assert, finish, freshDir } from "./util.js";
import { AGENTS, agentEnv, loadCustomAgents } from "../src/core/agents.js";
import { mcpServerList, parseMcpNames, readMcpConfig, resolveMcpServers, storedMcp, validateMcpEntry } from "../src/core/mcp-extra.js";
import { Hub } from "../src/core/hub.js";

const dir = freshDir(".hive-test-mcp");
process.env.HIVE_HOME = join(dir, "home");
freshDir(process.env.HIVE_HOME);
const probe = resolve("test/fixtures/env-mcp.mjs");

// ---- validation ----
const throws = (f: () => unknown) => {
  try {
    f();
    return false;
  } catch {
    return true;
  }
};
assert(throws(() => validateMcpEntry({ name: "hive", command: "x" })), '"hive" is reserved');
assert(throws(() => validateMcpEntry({ name: "bad name", command: "x" })), "names are checked");
assert(throws(() => validateMcpEntry({ name: "ok" })), "command is required");
assert(throws(() => validateMcpEntry({ name: "ok", command: "x", args: [1] })), "args must be strings");
assert(throws(() => validateMcpEntry({ name: "ok", command: "x", env: { "A-B": "1" } })), "env names must be variable names");
assert(throws(() => parseMcpNames(["good", "../evil"])), "--mcp names are checked");
assert(parseMcpNames(["a,b", "a"]).join() === "a,b", "--mcp a,b and repeats are merged");

// ---- mcp.json ----
writeFileSync(
  join(process.env.HIVE_HOME, "mcp.json"),
  JSON.stringify({
    probe: { command: process.execPath, args: [probe, "named"], env: { PROBE_TOKEN: "${MY_PROBE_TOKEN}", EMPTY: "${NOT_SET_ANYWHERE}" } },
    broken: { args: ["no command"] },
  }),
);
const cfg = readMcpConfig();
assert(cfg.probe && !cfg.broken, "mcp.json: valid entries load, invalid ones are skipped");
assert(mcpServerList().map((s) => s.name).join() === "probe", "server list for the Add-agent dialog");

process.env.MY_PROBE_TOKEN = "tok-123";
process.env.ELEVENLABS_API_KEY = "eleven-secret";
process.env.TWITCH_CLIENT_SECRET = "twitch-secret";
const r = resolveMcpServers([], ["probe"]);
assert(r.length === 1 && r[0].env.length === 1 && r[0].env[0].name === "PROBE_TOKEN" && r[0].env[0].value === "tok-123", "only the env the entry names is passed (${VAR} expanded, unset dropped)");
assert(throws(() => resolveMcpServers([], ["nope"])), "an unknown server name is an error, not silently ignored");
assert(resolveMcpServers([{ name: "probe", command: "a" }], ["probe"]).length === 1, "duplicates collapse (type's entry wins)");

// The agent process (which spawns the servers) doesn't get hive's media key or Twitch secret.
const ae = agentEnv(AGENTS.mock);
assert(!ae.ELEVENLABS_API_KEY && !ae.TWITCH_CLIENT_SECRET, "agent env drops media keys and the Twitch secret");

// ---- agents.json: a custom type with servers, and servers added to a built-in type ----
const agentsJson = join(process.env.HIVE_HOME, "agents.json");
writeFileSync(
  agentsJson,
  JSON.stringify({
    "mock-editor": { type: "acp", command: AGENTS.mock.command, args: AGENTS.mock.args, mcp: ["probe"] },
    mock: { mcp: [{ name: "inline", command: process.execPath, args: [probe, "inline"] }] },
    bad: { type: "acp", command: "x", mcp: [{ name: "hive", command: "x" }] },
  }),
);
const added = loadCustomAgents(agentsJson);
assert(added.includes("mock-editor") && AGENTS["mock-editor"].mcp?.[0] === "probe", "agents.json: an ACP type with an mcp list");
assert(!added.includes("bad"), "agents.json: an invalid mcp entry rejects that type");
assert((AGENTS.mock.mcp?.[0] as any)?.name === "inline", "agents.json: { mock: { mcp } } adds servers to a built-in type");

// ---- end to end: the agent really gets them in session/new ----
const hub = new Hub({ hiveDb: join(dir, "hive.db") });
const a = await hub.add({ name: "editor", agent: "mock-editor", cwd: dir, policy: "allow-all", mcp: ["probe"] });
await a.prompt('calltool env_probe {}');
const out = JSON.parse(a.lastReply.slice(a.lastReply.indexOf("{"), a.lastReply.indexOf("}") + 1));
assert(out.token === "tok-123" && out.arg === "named", `the attached server runs and sees its named env (${a.lastReply.slice(0, 120)})`);
assert(out.eleven === null && out.twitch === null, "the server doesn't see hive's media key or Twitch secret");
assert(a.extraMcp.join() === "probe", "attached servers are listed for the pane tooltip");
assert(storedMcp(hub.db, "editor").join() === "probe", "attachments are remembered for wake-ups and restarts");

// The built-in type's inline server reaches a plain mock agent.
const b = await hub.add({ name: "plain", agent: "mock", cwd: dir, policy: "allow-all" });
await b.prompt('calltool env_probe {}');
assert(/"arg":"inline"/.test(b.lastReply), "a type's servers reach every agent of that type");

// Restart without --mcp: the stored list is used again.
await hub.remove("editor", false);
const a2 = await hub.add({ name: "editor", agent: "mock-editor", cwd: dir, policy: "allow-all", resume: true });
assert(a2.extraMcp.join() === "probe", "a restarted agent gets its servers back");
await hub.remove("editor", true);
assert(storedMcp(hub.db, "editor").length === 0, "forgetting an agent forgets its servers");

let failed = "";
try {
  await hub.add({ name: "typo", agent: "mock", cwd: dir, mcp: ["davinvi"] });
} catch (e: any) {
  failed = e.message;
}
assert(/davinvi/.test(failed), "a typo in --mcp fails the start with the name");

await hub.close();
delete AGENTS["mock-editor"];
finish("mcp-extra");
