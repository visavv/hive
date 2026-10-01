/** Twitch → board: fake Helix (token, users, videos, clips), dedupe, labels, blackboard wake-up, token refresh. */
import { createServer } from "node:http";
import { join } from "node:path";
import { assert, finish, freshDir } from "./util.js";
import { Board } from "../src/hive/kanban.js";
import { HiveDb } from "../src/hive/db.js";
import { pollTwitch, resetTwitchToken } from "../src/hive/twitch.js";

const dir = freshDir(".hive-test-twitch");
const hits: { url: string; auth?: string; client?: string; body: string }[] = [];
let tokenN = 0;
let valid = new Set<string>();
const clips = [
  { id: "ClipA", url: "https://clips.twitch.tv/ClipA", title: "insane clutch", duration: 28.4, created_at: "2026-09-30T20:00:00Z", creator_name: "viewer1", view_count: 42, video_id: "111", vod_offset: 3600 },
];
const videos = [
  { id: "111", title: "Friday stream", url: "https://www.twitch.tv/videos/111", duration: "3h2m1s", created_at: "2026-09-30T18:00:00Z" },
  { id: "110", title: "Thursday stream", url: "https://www.twitch.tv/videos/110", duration: "45m3s", created_at: "2026-09-29T18:00:00Z" },
];
const server = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  hits.push({ url: req.url!, auth: req.headers.authorization, client: req.headers["client-id"] as string, body });
  if (req.url === "/oauth2/token" && req.method === "POST") {
    const p = new URLSearchParams(body);
    if (p.get("client_id") !== "cid" || p.get("client_secret") !== "secret" || p.get("grant_type") !== "client_credentials") return res.writeHead(403).end("bad");
    const t = `tok${++tokenN}`;
    valid.add(t);
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: t, expires_in: 5000000, token_type: "bearer" }));
  }
  const t = req.headers.authorization?.replace("Bearer ", "") ?? "";
  if (!valid.has(t) || req.headers["client-id"] !== "cid") return res.writeHead(401).end(JSON.stringify({ message: "Invalid OAuth token" }));
  const u = new URL(req.url!, "http://x");
  if (u.pathname === "/helix/users") return res.writeHead(200).end(JSON.stringify({ data: u.searchParams.get("login") === "mychannel" ? [{ id: "999", login: "mychannel" }] : [] }));
  if (u.pathname === "/helix/videos") return res.writeHead(200).end(JSON.stringify({ data: u.searchParams.get("user_id") === "999" && u.searchParams.get("type") === "archive" ? videos : [] }));
  if (u.pathname === "/helix/clips") return res.writeHead(200).end(JSON.stringify({ data: u.searchParams.get("broadcaster_id") === "999" && u.searchParams.get("started_at") ? clips : [] }));
  res.writeHead(404).end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;

// Missing creds: a clear message, no request.
delete process.env.TWITCH_CLIENT_ID;
let err = "";
await pollTwitch({ channel: "mychannel", board: new Board(join(dir, "none.db")) }).catch((e) => (err = e.message));
assert(/TWITCH_CLIENT_ID/.test(err) && hits.length === 0, "missing TWITCH_CLIENT_ID is explained");

Object.assign(process.env, { TWITCH_CLIENT_ID: "cid", TWITCH_CLIENT_SECRET: "secret", TWITCH_CHANNEL: "MyChannel", TWITCH_API_BASE: `${base}/helix`, TWITCH_AUTH_BASE: base });
const b = new Board(join(dir, "board.db"));
const db = new HiveDb(join(dir, "hive.db"));

const r1 = await pollTwitch({ board: b, db, project: "stream" });
assert(hits.filter((h) => h.url === "/oauth2/token").length === 1, "app access token via client credentials");
assert(hits.filter((h) => h.url.startsWith("/helix")).every((h) => h.client === "cid" && h.auth === "Bearer tok1"), "Helix calls carry Client-Id and the bearer token");
assert(r1.created.length === 3, `one card per new VOD and clip (${r1.created.length})`);
const cards = b.list();
const clip = cards.find((c) => c.title === "Clip: insane clutch")!;
const vod = cards.find((c) => c.title === "VOD: Friday stream")!;
assert(clip && clip.labels.join() === "twitch,clip" && clip.source === "twitch" && clip.col === "draft" && clip.project === "stream", "clip card: labels twitch+clip, source twitch, Draft, project");
assert(vod && vod.labels.join() === "twitch,vod" && /3h02m01s/.test(vod.body) && vod.body.startsWith("https://www.twitch.tv/videos/111"), "VOD card: link first, duration, labels twitch+vod");
assert(/0:28/.test(clip.body) && /2026-09-30T20:00:00Z/.test(clip.body) && /videos\/111\?t=3600s/.test(clip.body), "clip card: duration, created_at, link to the VOD moment");
assert(cards[0].title === "Clip: insane clutch" || cards[0].title === "VOD: Friday stream", "newest items end up on top");
const bb = db.bbList("twitch/new/");
assert(bb.length === 3 && bb.every((e) => e.updated_by === "twitch") && JSON.parse(db.bbGet("twitch/new/clip-ClipA")!.value).card === clip.id, "each new card is announced on the blackboard (wakes the clipper's watch job)");

// Second poll: nothing new, no new token.
const r2 = await pollTwitch({ board: b, db });
assert(r2.created.length === 0 && r2.known === 3 && b.list().length === 3, "second poll creates nothing new (dedupe)");
assert(hits.filter((h) => h.url === "/oauth2/token").length === 1, "the token is reused (memory only)");

// A new clip appears.
clips.unshift({ id: "ClipB", url: "https://clips.twitch.tv/ClipB", title: "funny fail", duration: 15, created_at: "2026-10-01T10:00:00Z", creator_name: "viewer2", view_count: 3, video_id: "", vod_offset: null as any });
// …and the token was revoked: one 401, a fresh token, the call retried.
valid = new Set();
const r3 = await pollTwitch({ board: b, db });
assert(r3.created.length === 1 && r3.created[0].title === "Clip: funny fail", "a new clip makes exactly one card");
assert(hits.filter((h) => h.url === "/oauth2/token").length === 2, "a 401 fetches a new token and retries");

// Two pollers at once (UI + serve) never duplicate a card.
clips.unshift({ id: "ClipC", url: "https://clips.twitch.tv/ClipC", title: "race", duration: 9, created_at: "2026-10-01T11:00:00Z", creator_name: "v", view_count: 1, video_id: "", vod_offset: null as any });
const b2 = new Board(join(dir, "board.db"));
await Promise.all([pollTwitch({ board: b, db }), pollTwitch({ board: b2, db })]);
assert(b.list().filter((c) => c.title === "Clip: race").length === 1, "concurrent polls create one card");

// First poll of a channel with a long history: only the newest `backfill` per kind.
resetTwitchToken();
const b3 = new Board(join(dir, "board3.db"));
const r4 = await pollTwitch({ board: b3, backfill: 1 });
assert(r4.created.length === 2 && r4.skipped === videos.length - 1 + clips.length - 1, `first poll backfills only the newest per kind (${r4.created.length} cards, ${r4.skipped} skipped)`);

// The token never touches a database.
const { readFileSync } = await import("node:fs");
for (const f of ["board.db", "hive.db"]) assert(!readFileSync(join(dir, f)).includes("tok1") && !readFileSync(join(dir, f)).includes("secret"), `no token or secret stored in ${f}`);

err = "";
await pollTwitch({ board: b, channel: "nobody" }).catch((e) => (err = e.message));
assert(/no Twitch channel "nobody"/.test(err), "unknown channel is explained");

// Recipe: clipper + studio, watch jobs on the blackboard, polling turned on for the project.
const { RECIPES, applyRecipe } = await import("../src/core/recipes.js");
const ar = applyRecipe(db, RECIPES["twitch-clips"], { cwd: dir, kind: "mock" });
const jobs = db.listJobs(false);
assert(ar.agents.map((a) => a.name).join() === "clipper,studio" && jobs.some((j) => j.agent === "clipper" && j.watch_path === "@bb:twitch/new/"), "recipe twitch-clips: clipper watches twitch/new/, studio writes titles");
assert(db.getSetting("twitch.every_ms") === "600000", "recipe turns on 10-minute polling for hive serve / the app");

b.close();
b2.close();
b3.close();
db.close();
server.close();
finish("twitch");
