/** Token ledger: categorisation, stats by dimension, filters, share. */
import { join } from "node:path";
import { assert, finish, freshDir } from "./util.js";
process.env.HIVE_HOME = freshDir(".hive-test-ledger");
const { record, stats, facets, vendorOf, categoryOf, closeLedger } = await import("../src/core/ledger.js");

assert(vendorOf("claude", "Default (recommended)") === "Anthropic" && vendorOf("codex", "gpt-5") === "OpenAI" && vendorOf("openrouter", "meta-llama/llama-4-maverick") === "Meta" && vendorOf("gemini-api", "gemini-2.5-pro") === "Google" && vendorOf("ollama", "qwen3:32b") === "Alibaba" && vendorOf("ollama", "") === "Local", "vendor from model name, else agent type");
assert(categoryOf("code reviewer", "reviewer") === "review" && categoryOf("tester", "tester") === "testing" && categoryOf("planner / tech lead", "planner") === "planning" && categoryOf("", "coder") === "coding" && categoryOf("verdict #3 judge", "v3-judge") === "verdict judge" && categoryOf("", "alpha") === "general", "task category from role and name");

const now = Date.now();
record({ project: "/x/app", agent: "coder", kind: "claude", model: "opus", role: "coder", tokens: 6000, costUsd: 0.3 });
record({ project: "/x/app", agent: "reviewer", kind: "codex", model: "gpt-5", role: "code reviewer", tokens: 3000 });
record({ project: "/x/site", agent: "reviewer", kind: "codex", model: "gpt-5", role: "code reviewer", tokens: 1000 });
record({ project: "/x/app", agent: "old", kind: "claude", tokens: 500, ts: now - 40 * 86_400_000 });
record({ project: "/x/app", agent: "zero", kind: "claude", tokens: 0 });

const v = stats("vendor", { since: now - 30 * 86_400_000 });
assert(v.total.tokens === 10_000 && v.total.turns === 3, `range filter and zero-token turns skipped (${v.total.tokens}/${v.total.turns})`);
assert(v.rows[0].key === "Anthropic" && Math.abs(v.rows[0].share - 0.6) < 1e-9 && v.rows[1].key === "OpenAI" && Math.abs(v.rows[1].share - 0.4) < 1e-9, "grouped by provider, biggest first, with share of total");
const c = stats("category", {});
assert(c.rows.find((r) => r.key === "review")!.tokens === 4000, "review work summed across projects");
const p = stats("project", { category: "review" });
assert(p.total.tokens === 4000 && p.rows[0].key === "app" && p.rows[0].tokens === 3000, "filter by task, grouped by project");
const f = facets();
assert(f.vendor.includes("OpenAI") && f.project.includes("site") && f.category.includes("coding"), "filter menus list what exists");
const d = stats("day", {});
assert(d.rows.length === 2 && d.rows[0].key < d.rows[1].key, "per-day series in date order");
closeLedger();
finish("ledger");
