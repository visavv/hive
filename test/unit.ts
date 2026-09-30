/** Pure-function checks: Windows spawn quoting, readTextFile slicing, doctor summaries. */
import { AGENTS, spawnSpec, winQuote } from "../src/core/agents.js";
import { sliceLines } from "../src/core/session.js";
import { summarize } from "../src/core/doctor.js";
import { isRateLimit, resetTime } from "../src/core/scheduler.js";
import { HiveDb } from "../src/hive/db.js";
import { assert, finish, freshDir } from "./util.js";

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

// usage-limit detection
assert(isRateLimit("Claude AI usage limit reached|1760000000") && isRateLimit("429 Too Many Requests") && !isRateLimit("file not found") && !isRateLimit("429 insufficient_quota: check your billing"), "isRateLimit (billing errors are real failures)");
const now = 1_760_000_000_000;
assert(resetTime("limit reached|1760003600", now) === 1_760_003_600_000 + 60_000, "resetTime from unix epoch");
assert(resetTime("try again in 5 minutes", now) === now + 300_000 + 5_000, "resetTime from 'in N minutes'");
assert(resetTime("nope", now) === undefined, "resetTime unknown");

// broadcast read state is per agent
const db = new HiveDb(`${freshDir(".hive-test-unit")}/h.db`);
const bid = db.send("a", "*", "announce", "hello all");
db.send("a", "b", "direct", "just b");
assert(db.unreadCount("b") === 2 && db.unreadCount("c") === 1 && db.unreadCount("a") === 0, "broadcast counts for everyone but the sender");
db.markRead(db.inbox("b").map((m) => m.id), "b");
assert(db.unreadCount("b") === 0 && db.unreadCount("c") === 1, "b reading a broadcast doesn't mark it read for c");
assert(db.inbox("c")[0]?.id === bid && db.inbox("c", false)[0].read_at == null, "c still sees the broadcast unread");
assert(db.inbox("b", false).every((m) => m.read_at != null), "b's view shows both read");
db.close();

finish("unit");
