/**
 * Twitch → board: poll a channel's new VODs and clips (Helix API) and put a
 * Kanban card on the board for each, so a clipper agent (recipe
 * "twitch-clips") can cut them into shorts.
 *
 *   TWITCH_CLIENT_ID + TWITCH_CLIENT_SECRET   an app at dev.twitch.tv/console (app access token, client credentials)
 *   TWITCH_CHANNEL                            the channel login, e.g. "mychannel"
 *   TWITCH_API_BASE / TWITCH_AUTH_BASE        overrides (tests)
 *
 * The token lives in memory only (never in a db or file) and is fetched again
 * when it expires or Helix says 401. Seen ids are kept in board.db
 * (twitch_seen), so two hive processes polling at once can't make the same
 * card twice. Each new card also lands on the project's blackboard under
 * twitch/new/<kind>-<id>, which wakes a watch job (the clipper).
 *
 * Runs: `hive twitch poll` (once), `hive twitch watch` (foreground loop), or
 * `hive twitch watch --detach` / the recipe: `hive serve` and the app poll
 * every twitch.every_ms (setting in the project's hive).
 */
import type { HiveDb } from "./db.js";
import { board as sharedBoard, type Board, type Card } from "./kanban.js";

const env = process.env;
const apiBase = () => (env.TWITCH_API_BASE || "https://api.twitch.tv/helix").replace(/\/+$/, "");
const authBase = () => (env.TWITCH_AUTH_BASE || "https://id.twitch.tv").replace(/\/+$/, "");

export const twitchConfigured = () => !!(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET);
export function twitchMissing(): string | undefined {
  const miss = ["TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET"].filter((k) => !env[k]);
  return miss.length ? `set ${miss.join(" and ")} (create an app at https://dev.twitch.tv/console; docs/CREATOR.md)` : undefined;
}

export interface TwitchItem {
  kind: "vod" | "clip";
  id: string;
  title: string;
  url: string;
  /** Human duration: "3h02m11s" / "0:28". */
  duration: string;
  createdAt: string;
  /** Clips: who clipped it, views, the VOD it came from. */
  creator?: string;
  views?: number;
  vodId?: string;
  vodOffset?: number | null;
}

// ---- Helix ----

let token: { value: string; until: number; client: string } | undefined;

/** App access token (client credentials), cached in memory. */
async function appToken(force = false): Promise<string> {
  const id = env.TWITCH_CLIENT_ID ?? "";
  if (!force && token && token.client === id && token.until > Date.now() + 60_000) return token.value;
  const missing = twitchMissing();
  if (missing) throw new Error(missing);
  const body = new URLSearchParams({ client_id: id, client_secret: env.TWITCH_CLIENT_SECRET!, grant_type: "client_credentials" });
  const r = await fetch(`${authBase()}/oauth2/token`, { method: "POST", body, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) {
    const t = (await r.text().catch(() => "")).slice(0, 300);
    throw new Error(r.status === 400 || r.status === 403 ? `Twitch refused the client id/secret (${r.status}). ${t}` : `Twitch token ${r.status}: ${t}`);
  }
  const j: any = await r.json();
  if (!j.access_token) throw new Error("Twitch returned no access token");
  token = { value: j.access_token, until: Date.now() + (Number(j.expires_in) || 3600) * 1000, client: id };
  return token.value;
}

/** Forget the cached token (tests; a changed client id is handled automatically). */
export function resetTwitchToken() {
  token = undefined;
}

async function helix(path: string): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const t = await appToken(attempt > 0);
    const r = await fetch(`${apiBase()}${path}`, {
      headers: { "Client-Id": env.TWITCH_CLIENT_ID!, Authorization: `Bearer ${t}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (r.status === 401 && attempt === 0) continue; // token expired or revoked: fetch a new one once
    if (!r.ok) throw new Error(`Twitch ${path.split("?")[0]} ${r.status}: ${(await r.text().catch(() => "")).slice(0, 300)}`);
    return r.json();
  }
}

const userIds = new Map<string, string>();
async function userId(login: string): Promise<string> {
  const key = login.toLowerCase();
  const hit = userIds.get(key);
  if (hit) return hit;
  const j = await helix(`/users?login=${encodeURIComponent(key)}`);
  const id = j.data?.[0]?.id;
  if (!id) throw new Error(`no Twitch channel "${login}"`);
  userIds.set(key, id);
  return id;
}

/** "3h2m1s" → "3h02m01s" (Helix VOD durations). */
function vodDuration(d: string): string {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(d ?? "");
  if (!m) return String(d ?? "");
  const [h, mi, s] = [m[1], m[2], m[3]].map((x) => Number(x ?? 0));
  return h ? `${h}h${String(mi).padStart(2, "0")}m${String(s).padStart(2, "0")}s` : `${mi}m${String(s).padStart(2, "0")}s`;
}
function clipDuration(sec: number): string {
  const s = Math.round(Number(sec) || 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Newest first, as Helix returns them. */
export async function fetchTwitch(channel: string, kinds: ("vod" | "clip")[] = ["vod", "clip"], clipDays = 14): Promise<TwitchItem[]> {
  const uid = await userId(channel);
  const out: TwitchItem[] = [];
  if (kinds.includes("vod")) {
    const j = await helix(`/videos?user_id=${uid}&type=archive&first=20`);
    for (const v of j.data ?? [])
      out.push({ kind: "vod", id: String(v.id), title: String(v.title ?? "(untitled)"), url: String(v.url ?? `https://www.twitch.tv/videos/${v.id}`), duration: vodDuration(v.duration), createdAt: String(v.created_at ?? "") });
  }
  if (kinds.includes("clip")) {
    const since = new Date(Date.now() - clipDays * 86_400_000).toISOString();
    const j = await helix(`/clips?broadcaster_id=${uid}&first=20&started_at=${encodeURIComponent(since)}`);
    const clips = [...(j.data ?? [])].sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)));
    for (const c of clips)
      out.push({
        kind: "clip",
        id: String(c.id),
        title: String(c.title ?? "(untitled)"),
        url: String(c.url ?? `https://clips.twitch.tv/${c.id}`),
        duration: clipDuration(c.duration),
        createdAt: String(c.created_at ?? ""),
        creator: c.creator_name,
        views: c.view_count,
        vodId: c.video_id || undefined,
        vodOffset: c.vod_offset ?? null,
      });
  }
  return out;
}

// ---- seen ids + cards ----

function seenTable(b: Board) {
  b.db.exec(`CREATE TABLE IF NOT EXISTS twitch_seen (
    id TEXT NOT NULL, kind TEXT NOT NULL, channel TEXT NOT NULL, card_id INTEGER, seen_at INTEGER NOT NULL,
    PRIMARY KEY (kind, id)
  )`);
}

function cardBody(it: TwitchItem, channel: string): string {
  const lines = [
    it.url,
    "",
    `- channel: ${channel}`,
    `- ${it.kind === "vod" ? "VOD" : "clip"} id: ${it.id}`,
    `- duration: ${it.duration}`,
    `- created: ${it.createdAt}`,
  ];
  if (it.kind === "clip") {
    if (it.creator) lines.push(`- clipped by: ${it.creator}`);
    if (it.views != null) lines.push(`- views: ${it.views}`);
    if (it.vodId) lines.push(`- from VOD: https://www.twitch.tv/videos/${it.vodId}${it.vodOffset != null ? `?t=${Math.max(0, Math.floor(it.vodOffset))}s` : ""}`);
  }
  return lines.join("\n");
}

export interface PollResult {
  created: Card[];
  /** Items that were already on the board (or skipped on the first poll). */
  known: number;
  /** First poll of this channel: older items marked seen without cards. */
  skipped: number;
}

/**
 * One poll: a card (Draft, labels twitch + vod/clip, source "twitch") per item
 * not seen before. On the very first poll of a channel only the newest
 * `backfill` items per kind get cards, so a channel with years of VODs doesn't
 * flood the board.
 */
export async function pollTwitch(o: { channel?: string; board?: Board; db?: HiveDb; project?: string; backfill?: number; kinds?: ("vod" | "clip")[] } = {}): Promise<PollResult> {
  const channel = (o.channel ?? env.TWITCH_CHANNEL ?? "").trim().toLowerCase();
  if (!channel) throw new Error("set TWITCH_CHANNEL (the channel login) or pass --channel");
  if (!/^\w{2,25}$/.test(channel)) throw new Error(`"${channel}" isn't a Twitch login`);
  const b = o.board ?? sharedBoard();
  seenTable(b);
  const items = await fetchTwitch(channel, o.kinds);
  const backfill = o.backfill ?? 3;
  const res: PollResult = { created: [], known: 0, skipped: 0 };
  for (const kind of ["vod", "clip"] as const) {
    const first = !b.db.prepare(`SELECT 1 FROM twitch_seen WHERE channel=? AND kind=? LIMIT 1`).get(channel, kind);
    const list = items.filter((i) => i.kind === kind);
    // Oldest first, so the newest card ends up on top of Draft.
    list.reverse().forEach((it, i) => {
      const quiet = first && list.length - i > backfill;
      // Claim the id and make the card in one transaction: concurrent pollers can't both create it.
      const made = b.db.transaction(() => {
        const claim = b.db.prepare(`INSERT OR IGNORE INTO twitch_seen (id, kind, channel, card_id, seen_at) VALUES (?,?,?,NULL,?)`).run(it.id, kind, channel, Date.now());
        if (!claim.changes) return null;
        if (quiet) return "skipped" as const;
        const card = b.add({
          title: `${kind === "vod" ? "VOD" : "Clip"}: ${it.title}`.slice(0, 300),
          body: cardBody(it, channel),
          project: o.project ?? "",
          labels: ["twitch", kind],
          source: "twitch",
        });
        b.db.prepare(`UPDATE twitch_seen SET card_id=? WHERE kind=? AND id=?`).run(card.id, kind, it.id);
        return card;
      })();
      if (made === null) res.known++;
      else if (made === "skipped") res.skipped++;
      else {
        res.created.push(made);
        // Wake the clipper (watch job on @bb:twitch/new/). Blackboard text from Twitch is shown to agents as untrusted.
        o.db?.bbSet(`twitch/new/${kind}-${it.id}`, JSON.stringify({ card: made.id, kind, url: it.url, title: it.title, duration: it.duration, created: it.createdAt, vod: it.vodId, vodOffset: it.vodOffset }), "twitch");
      }
    });
  }
  return res;
}

// ---- background polling in `hive serve` / the app ----

export const TWITCH_EVERY_KEY = "twitch.every_ms";
export const TWITCH_MIN_EVERY = 2 * 60_000;

/**
 * Poll every twitch.every_ms (project setting) while the creds are set. Several
 * hive processes may run this; twitch.last_poll keeps them from all polling,
 * and the seen table keeps cards unique anyway.
 */
export function startTwitchWatcher(db: HiveDb, onResult?: (r: PollResult | Error) => void): { stop: () => void } {
  let busy = false;
  const tick = async () => {
    if (busy || !db.db.open || !twitchConfigured()) return;
    const every = Number(db.getSetting(TWITCH_EVERY_KEY) ?? 0);
    if (!(every > 0)) return;
    const last = Number(db.getSetting("twitch.last_poll") ?? 0);
    if (Date.now() - last < Math.max(TWITCH_MIN_EVERY, every)) return;
    busy = true;
    db.setSetting("twitch.last_poll", String(Date.now()));
    try {
      const r = await pollTwitch({ db, channel: db.getSetting("twitch.channel") ?? undefined, project: db.getSetting("twitch.project") ?? undefined });
      if (db.db.open) db.setSetting("twitch.last_error", null);
      onResult?.(r);
    } catch (e: any) {
      if (db.db.open) db.setSetting("twitch.last_error", String(e?.message ?? e).slice(0, 300));
      onResult?.(e instanceof Error ? e : new Error(String(e)));
    } finally {
      busy = false;
    }
  };
  const t = setInterval(() => void tick(), 15_000);
  t.unref?.();
  return { stop: () => clearInterval(t) };
}
