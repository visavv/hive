/** YouTube links as skill input: id parsing, caption parsing, fetch via the player API (fake server), skills. */
import { createServer } from "node:http";
import { join } from "node:path";
import { assert, finish, freshDir } from "./util.js";

const dir = freshDir(".hive-test-youtube");
process.env.HIVE_HOME = join(dir, "home");
process.env.HIVE_YT_DLP = "0";
let playerCalls = 0;
const server = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  if (req.url!.startsWith("/youtubei/v1/player")) {
    playerCalls++;
    const { videoId } = JSON.parse(body);
    if (videoId === "nocaptions1") return res.end(JSON.stringify({ playabilityStatus: { status: "OK" }, videoDetails: { title: "x" } }));
    return res.end(
      JSON.stringify({
        playabilityStatus: { status: "OK" },
        videoDetails: { title: "Why my first startup failed", author: "Sample Creator" },
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [
              { baseUrl: "/api/timedtext?v=x&lang=en&kind=asr&fmt=srv3", languageCode: "en", kind: "asr" },
              { baseUrl: "/api/timedtext?v=x&lang=en&fmt=srv3", languageCode: "en" },
            ],
          },
        },
      }),
    );
  }
  if (req.url!.startsWith("/api/timedtext")) {
    const asr = req.url!.includes("kind=asr");
    return res.end(
      `<?xml version="1.0"?><transcript><text start="1.2" dur="2">${asr ? "auto" : "Hello &amp; welcome"}</text><text start="65" dur="3">the failures are the point &#39;really&#39;</text></transcript>`,
    );
  }
  res.writeHead(404).end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
process.env.HIVE_YT_BASE = `http://127.0.0.1:${(server.address() as any).port}`;

const { youtubeId, parseVtt, transcriptFile } = await import("../src/core/youtube.js");
const { readFileSync } = await import("node:fs");
assert(
  youtubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10") === "dQw4w9WgXcQ" &&
    youtubeId("https://youtu.be/dQw4w9WgXcQ?si=x") === "dQw4w9WgXcQ" &&
    youtubeId("https://youtube.com/shorts/dQw4w9WgXcQ") === "dQw4w9WgXcQ" &&
    youtubeId("https://m.youtube.com/live/dQw4w9WgXcQ") === "dQw4w9WgXcQ",
  "video ids from watch / youtu.be / shorts / live links",
);
assert(youtubeId("notes/transcript.srt") === undefined && youtubeId("https://example.com/watch?v=dQw4w9WgXcQ") === undefined, "files and other sites aren't YouTube links");
const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nhello\n\n00:00:02.000 --> 00:00:04.000\nhello there\n\n00:01:05.500 --> 00:01:07.000\n<c>next</c> part\n";
assert(parseVtt(vtt) === "[0:01] hello\n[0:02] there\n[1:05] next part", `rolling auto-captions are de-duplicated (${JSON.stringify(parseVtt(vtt))})`);

const path = await transcriptFile("https://youtu.be/abcdefghijk");
const txt = readFileSync(path, "utf8");
assert(txt.includes("Title: Why my first startup failed") && txt.includes("[0:01] Hello & welcome") && txt.includes("[1:05] the failures are the point 'really'"), "transcript with title and timestamps; manual captions preferred over auto");
await transcriptFile("https://youtu.be/abcdefghijk");
assert(playerCalls === 1, "transcripts are cached");
let err = "";
try {
  await transcriptFile("https://youtu.be/nocaptions1");
} catch (e: any) {
  err = e.message;
}
assert(/no captions/.test(err) && /yt-dlp/.test(err) && /\.srt/.test(err), "no captions: says why and what to do instead");

// through a skill: the link becomes the transcript
const { Hub } = await import("../src/core/hub.js");
const { findSkill } = await import("../src/core/skills.js");
const { runSkill } = await import("../src/core/skill-run.js");
const hub = new Hub({ hiveDb: join(dir, "hive.db"), pollMs: 200 });
const sk = findSkill(dir, "yt-titles");
const r = await runSkill(hub, sk, { transcript: "https://www.youtube.com/watch?v=abcdefghijk", working_title: "my startup" }, { cwd: dir, kind: "mock" });
const sent = hub.db.agentEvents(r.agent, ["prompt"], 5).map((e) => JSON.parse(e.data).text).join("\n");
assert(sent.includes("[1:05] the failures are the point") && sent.includes("Title: Why my first startup failed"), "yt-titles with a YouTube link gets the transcript");
await hub.close();
server.close();
finish("youtube");
