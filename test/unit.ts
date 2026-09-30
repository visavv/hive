/** Pure-function checks: Windows spawn quoting, readTextFile slicing, doctor summaries. */
import { AGENTS, spawnSpec, winQuote } from "../src/core/agents.js";
import { sliceLines } from "../src/core/session.js";
import { summarize } from "../src/core/doctor.js";
import { assert, finish } from "./util.js";

// spawnSpec
const claudeWin = spawnSpec({ ...AGENTS.claude, command: "npx.cmd" }, "win32");
assert(claudeWin.shell && claudeWin.command === "npx.cmd", "win32: npx.cmd runs through the shell");
const mockWin = spawnSpec({ ...AGENTS.mock, command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\a b\\cli.mjs", "x"] }, "win32");
assert(!mockWin.shell && mockWin.args[0] === "C:\\a b\\cli.mjs", "win32: absolute .exe spawns directly, args untouched");
const bare = spawnSpec({ ...AGENTS.qwen, args: ["--acp", "a b"] }, "win32");
assert(bare.shell && bare.args[1] === '"a b"', "win32: bare command (npm .cmd shim) uses shell with quoted args");
assert(!spawnSpec(AGENTS.claude, "linux").shell, "linux: no shell");
assert(winQuote('say "hi"') === '"say \\"hi\\""', "winQuote escapes quotes");
assert(winQuote("C:\\dir\\") === "C:\\dir\\", "winQuote leaves plain paths alone");
assert(winQuote("C:\\my dir\\") === '"C:\\my dir\\\\"', "winQuote doubles trailing backslashes inside quotes");
assert(!/^\/[A-Za-z]:/.test(AGENTS.mock.args.at(-1)!), "mock entry path is a filesystem path, not a URL pathname");

// sliceLines
const txt = "a\nb\nc\nd";
assert(sliceLines(txt) === txt, "no line/limit → whole file");
assert(sliceLines(txt, 2, 2) === "b\nc", "line 2 limit 2");
assert(sliceLines(txt, 3) === "c\nd", "line 3 to end");
assert(sliceLines(txt, null, 1) === "a", "limit only");

// doctor summarize
const s = summarize({
  protocolVersion: 1,
  agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} }, _meta: { authStatus: {}, claudeCode: { promptQueueing: true } } },
  agentInfo: { name: "x", version: "1" },
} as any);
assert(s.auth === "not reported" && s.features?.includes("resume") && s.features.includes("queueing"), "summarize: empty authStatus marker = not reported until pushed");

finish("unit");
