/**
 * Token ledger across every project: one row per finished turn with the vendor,
 * model, kind of work (coding, review, testing, …) and project, kept for good
 * in <HIVE_HOME>/usage.db so you can see where your tokens go over months.
 * The per-project usage_log (budgets, limit windows) is separate and pruned.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { hiveHome } from "./home.js";

export interface LedgerEntry {
  ts?: number;
  project: string; // repo root path
  agent: string;
  kind: string; // agent type id: claude, codex, gemini-api, …
  model?: string;
  role?: string;
  automatic?: boolean;
  tokens: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export type LedgerDim = "vendor" | "model" | "category" | "project" | "kind" | "agent" | "day";
export interface LedgerFilter {
  since?: number;
  until?: number;
  vendor?: string;
  model?: string;
  category?: string;
  project?: string;
}
export interface LedgerRow {
  key: string;
  tokens: number;
  cost: number;
  turns: number;
  share: number; // of all tokens matching the filter, 0..1
}

/** Who makes the model: from the model name when known, else from the agent type. */
export function vendorOf(kind: string, model?: string): string {
  const m = (model ?? "").toLowerCase();
  if (/claude|opus|sonnet|haiku/.test(m)) return "Anthropic";
  if (/gpt|codex|\bo[1-9]\b|o[1-9]-|openai/.test(m)) return "OpenAI";
  if (/gemini|gemma/.test(m)) return "Google";
  if (/llama|muse|meta/.test(m)) return "Meta";
  if (/qwen/.test(m)) return "Alibaba";
  if (/deepseek/.test(m)) return "DeepSeek";
  if (/mistral|codestral|devstral/.test(m)) return "Mistral";
  if (/glm|zhipu/.test(m)) return "Zhipu";
  if (/grok/.test(m)) return "xAI";
  const k = kind.toLowerCase();
  if (k.startsWith("claude")) return "Anthropic";
  if (k.startsWith("codex") || k.startsWith("openai")) return "OpenAI";
  if (k.startsWith("gemini")) return "Google";
  if (k.startsWith("llama") || k === "meta") return "Meta";
  if (k.startsWith("qwen")) return "Alibaba";
  if (k.startsWith("ollama")) return "Local";
  if (k.startsWith("media:")) return k.slice(6) === "tts" ? "ElevenLabs" : "Images";
  if (k === "mock") return "Test";
  return kind;
}

/** What the turn was for, from the agent's role and name. */
export function categoryOf(role = "", name = "", automatic = false): string {
  const t = `${role} ${name}`.toLowerCase();
  if (/prompt engineer/.test(t)) return "prompting";
  if (/judge/.test(t)) return "verdict judge";
  if (/verdict|contender|builder/.test(t)) return "verdict";
  if (/review/.test(t)) return "review";
  if (/test|qa\b|verif/.test(t)) return "testing";
  if (/plan|lead|architect/.test(t)) return "planning";
  if (/improv|refactor|simplif/.test(t)) return "refactoring";
  if (/^skill-|\bskill\b/.test(t) || name.startsWith("skill-")) return "skill";
  if (/studio|creative|writer|youtube|title|chat/.test(t)) return "creative";
  if (/scout|idea|polish|brainstorm/.test(t)) return "ideas";
  if (/cod|dev|implement|build|fix/.test(t)) return "coding";
  return automatic ? "automatic" : "general";
}

let db: Database.Database | undefined;
let dbPath: string | undefined;
function open(): Database.Database {
  const path = join(hiveHome(), "usage.db");
  if (db && dbPath === path && db.open) return db;
  mkdirSync(hiveHome(), { recursive: true });
  db = new Database(path);
  dbPath = path;
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 3000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS ledger (
      ts INTEGER NOT NULL,
      project TEXT NOT NULL,
      project_name TEXT NOT NULL,
      agent TEXT NOT NULL,
      kind TEXT NOT NULL,
      vendor TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL,
      automatic INTEGER NOT NULL DEFAULT 0,
      tokens INTEGER NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cost_usd REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS ledger_ts ON ledger(ts);
  `);
  return db;
}

export function record(e: LedgerEntry): void {
  if (!(e.tokens > 0) && !(e.costUsd! > 0)) return;
  open()
    .prepare(
      `INSERT INTO ledger (ts, project, project_name, agent, kind, vendor, model, category, automatic, tokens, input_tokens, output_tokens, cost_usd) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      e.ts ?? Date.now(),
      e.project,
      basename(e.project) || e.project,
      e.agent,
      e.kind,
      vendorOf(e.kind, e.model),
      e.model ?? "",
      categoryOf(e.role, e.agent, e.automatic),
      e.automatic ? 1 : 0,
      Math.max(0, Math.round(e.tokens || 0)),
      e.inputTokens ?? null,
      e.outputTokens ?? null,
      Math.max(0, e.costUsd ?? 0),
    );
}

const COL: Record<LedgerDim, string> = {
  vendor: "vendor",
  model: "CASE model WHEN '' THEN kind ELSE model END",
  category: "category",
  project: "project_name",
  kind: "kind",
  agent: "agent",
  day: "strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime')",
};

function where(f: LedgerFilter): { sql: string; args: (string | number)[] } {
  const c: string[] = [];
  const args: (string | number)[] = [];
  if (f.since) (c.push("ts >= ?"), args.push(f.since));
  if (f.until) (c.push("ts < ?"), args.push(f.until));
  if (f.vendor) (c.push("vendor = ?"), args.push(f.vendor));
  if (f.model) (c.push(`(${COL.model}) = ?`), args.push(f.model));
  if (f.category) (c.push("category = ?"), args.push(f.category));
  if (f.project) (c.push("project_name = ?"), args.push(f.project));
  return { sql: c.length ? `WHERE ${c.join(" AND ")}` : "", args };
}

/** Totals grouped by one dimension, biggest first, with each group's share of the filtered total. */
export function stats(by: LedgerDim, f: LedgerFilter = {}): { total: { tokens: number; cost: number; turns: number }; rows: LedgerRow[] } {
  const d = open();
  const w = where(f);
  const total = d.prepare(`SELECT COALESCE(SUM(tokens),0) AS tokens, COALESCE(SUM(cost_usd),0) AS cost, COUNT(*) AS turns FROM ledger ${w.sql}`).get(...w.args) as {
    tokens: number;
    cost: number;
    turns: number;
  };
  const rows = d
    .prepare(`SELECT ${COL[by]} AS key, SUM(tokens) AS tokens, SUM(cost_usd) AS cost, COUNT(*) AS turns FROM ledger ${w.sql} GROUP BY key ORDER BY ${by === "day" ? "key" : "tokens DESC"}`)
    .all(...w.args) as Omit<LedgerRow, "share">[];
  return { total, rows: rows.map((r) => ({ ...r, share: total.tokens ? r.tokens / total.tokens : 0 })) };
}

/** Distinct values for the filter menus. */
export function facets(f: LedgerFilter = {}): Record<"vendor" | "model" | "category" | "project", string[]> {
  const d = open();
  const w = where({ since: f.since, until: f.until });
  const pick = (col: string) => (d.prepare(`SELECT DISTINCT ${col} AS v FROM ledger ${w.sql} ORDER BY v`).all(...w.args) as { v: string }[]).map((r) => r.v);
  return { vendor: pick("vendor"), model: pick(COL.model), category: pick("category"), project: pick("project_name") };
}

/** For tests: close the shared handle. */
export function closeLedger() {
  db?.close();
  db = undefined;
}
