export function fmtIdle(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
  return `${Math.floor(h / 24)}d`;
}

export function ctxPct(used: number, size: number): number {
  return size > 0 ? Math.round((100 * used) / size) : 0;
}

export function statusLabel(s: string): string {
  return (
    {
      idle: "idle",
      working: "working",
      waiting: "waiting for you",
      error: "error",
      asleep: "stopped",
      starting: "starting",
    } as Record<string, string>
  )[s] ?? s;
}

const NAMES = [
  "zucchini", "bongo", "wombat", "pickle", "mango", "otter", "quokka", "biscuit", "noodle", "pepper",
  "walrus", "tofu", "gecko", "waffle", "badger", "kiwi", "lemur", "muffin", "narwhal", "olive",
];
export function suggestName(taken: Set<string>): string {
  for (const n of NAMES) if (!taken.has(n)) return n;
  let i = 2;
  while (taken.has(`agent${i}`)) i++;
  return `agent${i}`;
}

/** "10m" / "1h30m" / "45s" → ms (mirrors the CLI parser). */
export function parseDuration(s: string): number | undefined {
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/gy;
  const unit: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const str = s.trim().toLowerCase();
  let total = 0;
  let pos = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(str))) {
    total += Number(m[1]) * unit[m[2]];
    pos = re.lastIndex;
  }
  return str && pos === str.length && total > 0 ? total : undefined;
}
