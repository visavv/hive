/**
 * Spending guards for automatic work (scheduled jobs, mail wake-ups).
 * What you type yourself is never blocked — only automatic turns are.
 *
 * Settings (hive budget set key=value, or the UI):
 *   daily_tokens            all providers, per local day          (default: unlimited)
 *   daily_tokens.<provider> e.g. daily_tokens.claude               (default: unlimited)
 *   reserve_pct             stop automatic work when a subscription window
 *                           (e.g. Claude's 5-hour limit) is this full   (default: 85)
 *   max_concurrent          automatic runs at the same time        (default: 3)
 *   daily_tokens_api        per pay-per-token API provider (gemini-api, openrouter…)
 *                           without its own daily_tokens.<provider>   (default: 2,000,000)
 *   media_daily             image/voice API calls per day          (default: 40)
 *   paused                  "1" stops all automatic work           (default: off)
 */
import type { HiveDb } from "../hive/db.js";
import { AGENTS } from "./agents.js";

export const BUDGET_KEYS = ["daily_tokens", "daily_tokens_api", "reserve_pct", "max_concurrent", "media_daily", "paused"] as const;
const DEFAULTS: Record<string, string> = { reserve_pct: "85", max_concurrent: "3", media_daily: "40", daily_tokens_api: "2000000" };

/** Pay-per-token providers get a default daily cap for automatic work (an overnight loop can't run up a bill). */
function isApiProvider(provider: string): boolean {
  return !!AGENTS[provider]?.api;
}

export function budgetSetting(db: HiveDb, key: string): string | undefined {
  return db.getSetting(`budget.${key}`) ?? DEFAULTS[key];
}

export function startOfToday(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Resets are sometimes seconds, sometimes ms; utilization 0–1 or 0–100. */
export function normalizeLimit(utilization?: number | null, resetsAt?: number | null) {
  const pct = utilization == null ? null : utilization <= 1 ? utilization * 100 : utilization;
  const at = resetsAt == null ? null : resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
  return { pct, at };
}

export type Guard = { ok: true } | { ok: false; reason: string; until?: number };

/** May an automatic turn for `provider` start now? */
export function checkAutomatic(db: HiveDb, provider: string, now = Date.now()): Guard {
  if (budgetSetting(db, "paused") === "1") return { ok: false, reason: "automatic work is paused (hive budget set paused=0 to resume)" };
  const today = startOfToday(now);
  const tomorrow = today + 86_400_000;
  const usage = db.usageSince(today);
  const total = usage.reduce((n, u) => n + (u.tokens ?? 0), 0);
  const daily = Number(budgetSetting(db, "daily_tokens") ?? "");
  if (daily > 0 && total >= daily) return { ok: false, reason: `daily token budget reached (${total.toLocaleString()} / ${daily.toLocaleString()})`, until: tomorrow };
  // Own cap if set ("0" = no cap); else the default API cap for pay-per-token providers.
  const own = db.getSetting(`budget.daily_tokens.${provider}`);
  const perProv = Number(own ?? (isApiProvider(provider) ? (budgetSetting(db, "daily_tokens_api") ?? "") : ""));
  const used = usage.find((u) => u.provider === provider)?.tokens ?? 0;
  if (perProv > 0 && used >= perProv) return { ok: false, reason: `${provider} daily token budget reached (${used.toLocaleString()} / ${perProv.toLocaleString()})`, until: tomorrow };
  const reserve = Number(budgetSetting(db, "reserve_pct") ?? "85");
  for (const l of db.limits().filter((x) => x.provider === provider)) {
    const { pct, at } = normalizeLimit(l.utilization, l.resets_at);
    if (at != null && at <= now) continue; // window already reset
    if (l.status === "rejected") return { ok: false, reason: `${provider} ${l.window} limit reached`, until: at ?? undefined };
    if (pct != null && reserve > 0 && pct >= reserve)
      return { ok: false, reason: `${provider} ${l.window} window at ${Math.round(pct)}% (automatic work stops at ${reserve}% to keep the rest for you)`, until: at ?? undefined };
  }
  return { ok: true };
}

/** Tell the owner once per reason per day (mail → UI inbox badge and chat bridges). */
export function notifyOnce(db: HiveDb, g: Guard & { ok: false }) {
  const key = `budget.notified.${new Date().toDateString()}.${g.reason.replace(/[\d,]+/g, "#").slice(0, 80)}`;
  if (db.getSetting(key)) return;
  db.setSetting(key, "1");
  db.send("hive", "owner", "automatic work held back", `${g.reason}${g.until ? `\nResumes around ${new Date(g.until).toLocaleString()}.` : ""}\nYour own prompts still work. Change limits with \`hive budget\`.`);
}

export interface UsageSummary {
  providers: {
    provider: string;
    h5: number;
    d1: number;
    d7: number;
    cost7: number;
    limits: { window: string; pct: number | null; resetsAt: number | null; status: string | null; updatedAt: number }[];
    guard: Guard;
  }[];
  budget: Record<string, string>;
  /** Media API calls today vs the daily cap. */
  media: { today: number; cap: number };
}

export function usageSummary(db: HiveDb, now = Date.now()): UsageSummary {
  const h5 = db.usageSince(now - 5 * 3_600_000);
  const d1 = db.usageSince(startOfToday(now));
  const d7 = db.usageSince(now - 7 * 86_400_000);
  const limits = db.limits();
  const names = new Set([...d7.map((u) => u.provider), ...limits.map((l) => l.provider)].filter((p) => !p.startsWith("media:")));
  const mediaToday = d1.filter((u) => u.provider.startsWith("media:")).reduce((n, u) => n + u.turns, 0);
  const budget: Record<string, string> = {};
  for (const k of BUDGET_KEYS) {
    const v = budgetSetting(db, k);
    if (v != null) budget[k] = v;
  }
  for (const [k, v] of Object.entries(db.settings("budget.daily_tokens."))) budget[k.slice(7)] = v;
  return {
    budget,
    media: { today: mediaToday, cap: Number(budgetSetting(db, "media_daily") ?? "40") },
    providers: [...names].sort().map((p) => ({
      provider: p,
      h5: h5.find((u) => u.provider === p)?.tokens ?? 0,
      d1: d1.find((u) => u.provider === p)?.tokens ?? 0,
      d7: d7.find((u) => u.provider === p)?.tokens ?? 0,
      cost7: d7.find((u) => u.provider === p)?.cost ?? 0,
      limits: limits
        .filter((l) => l.provider === p)
        .map((l) => {
          const { pct, at } = normalizeLimit(l.utilization, l.resets_at);
          return { window: l.window, pct, resetsAt: at, status: l.status, updatedAt: l.updated_at };
        })
        .filter((l) => l.resetsAt == null || l.resetsAt > now || l.pct != null),
      guard: checkAutomatic(db, p, now),
    })),
  };
}

/** Validate and store one budget setting ("" clears it). Accepts 2m / 500k / 1_000. */
export function setBudget(db: HiveDb, key: string, val: string) {
  if (!(BUDGET_KEYS as readonly string[]).includes(key) && !/^daily_tokens\.[\w-]+$/.test(key))
    throw new Error(`unknown budget key "${key}" (keys: ${BUDGET_KEYS.join(", ")}, daily_tokens.<provider>)`);
  const v = val.trim();
  if (v === "") return db.setSetting(`budget.${key}`, null);
  if (key === "paused") return db.setSetting(`budget.${key}`, ["1", "on", "true", "yes"].includes(v.toLowerCase()) ? "1" : "0");
  const num = v.replace(/_/g, "").replace(/k$/i, "000").replace(/m$/i, "000000");
  if (!/^\d+$/.test(num)) throw new Error(`${key} must be a number (e.g. 2m, 500k)`);
  if (key === "reserve_pct" && Number(num) > 100) throw new Error("reserve_pct is a percentage (0-100; 0 turns the reserve off)");
  db.setSetting(`budget.${key}`, num);
}
