/**
 * Voice: speech-to-text for dictation (local Whisper server, OpenAI, ElevenLabs
 * Scribe) against fake APIs on 127.0.0.1, the size cap, the media budget and
 * ledger entries; the spoken-reply summariser; TTS through a fake ElevenLabs;
 * and the backend's transcribe / speak / voiceStatus RPCs over stdio.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { assert, finish, freshDir, until } from "./util.js";

const dir = freshDir(".hive-test-voice");
process.env.HIVE_HOME = freshDir(".hive-test-voice-home");
for (const k of ["HIVE_STT", "HIVE_STT_URL", "HIVE_STT_KEY", "HIVE_STT_MODEL", "HIVE_STT_BASE", "HIVE_STT_LANGUAGE", "OPENAI_API_KEY", "ELEVENLABS_API_KEY", "HIVE_STT_MAX_SECONDS"]) delete process.env[k];

type Seen = { url: string; headers: Record<string, any>; form?: FormData; json?: any; bytes: number };
const seen: Seen[] = [];
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);
  const s: Seen = { url: req.url!, headers: req.headers, bytes: body.length };
  if (String(req.headers["content-type"]).startsWith("multipart/form-data"))
    s.form = await new Request("http://x/", { method: "POST", headers: { "content-type": String(req.headers["content-type"]) }, body }).formData();
  else if (body.length) s.json = JSON.parse(body.toString());
  seen.push(s);
  const url = req.url!;
  if (url === "/local/v1/audio/transcriptions") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ text: " hello from whisper " }));
  if (url === "/openai/v1/audio/transcriptions") {
    if (req.headers.authorization !== "Bearer sk-test") return res.writeHead(401).end("bad key");
    return res.writeHead(200).end(JSON.stringify({ text: "hello from openai" }));
  }
  if (url === "/el/v1/speech-to-text") {
    if (req.headers["xi-api-key"] !== "el-test") return res.writeHead(401).end("bad key");
    return res.writeHead(200).end(JSON.stringify({ language_code: "en", text: "hello from scribe" }));
  }
  if (url.startsWith("/el/v1/text-to-speech/")) {
    if (req.headers["xi-api-key"] !== "el-test") return res.writeHead(401).end("bad key");
    return res.writeHead(200, { "content-type": "audio/mpeg" }).end(Buffer.from("ID3spoken"));
  }
  res.writeHead(404).end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;

const { HiveDb } = await import("../src/hive/db.js");
const voice = await import("../src/hive/voice.js");
const ledger = await import("../src/core/ledger.js");
const { usageSummary } = await import("../src/core/budget.js");
const db = new HiveDb(join(dir, "hive.db"));
const audio = Buffer.from("OggS-fake-opus-audio").toString("base64");
const project = dir;

// ---- provider selection ----
assert(voice.sttStatus().provider === null && /HIVE_STT_URL/.test(voice.sttStatus().problem ?? ""), "no provider configured: status says what to set");
let err = "";
await voice.transcribeFor(db, { audio, mime: "audio/webm", project }).catch((e) => (err = e.message));
assert(/no speech-to-text provider/.test(err), "transcribe without a provider explains instead of failing silently");
assert(
  voice.localEndpoint("http://h:8080") === "http://h:8080/v1/audio/transcriptions" &&
    voice.localEndpoint("http://h:8080/v1/") === "http://h:8080/v1/audio/transcriptions" &&
    voice.localEndpoint("http://h/x/v1/audio/transcriptions") === "http://h/x/v1/audio/transcriptions",
  "HIVE_STT_URL accepts host:port, a /v1 base or the full endpoint",
);

// ---- local Whisper server ----
process.env.HIVE_STT_URL = `${base}/local`;
process.env.OPENAI_API_KEY = "sk-test";
assert(voice.sttStatus().provider === "local", "auto picks the local server first when HIVE_STT_URL is set");
const r1 = await voice.transcribeFor(db, { audio, mime: "audio/webm;codecs=opus", seconds: 3, agent: "alpha", project });
const s1 = seen.at(-1)!;
const f1 = s1.form?.get("file") as File | null;
assert(r1.text === "hello from whisper" && r1.provider === "local", "local: text comes back trimmed");
assert(
  s1.url === "/local/v1/audio/transcriptions" && f1?.name === "dictation.webm" && f1.type === "audio/webm" && s1.form?.get("response_format") === "json" && !s1.form?.has("model") && !s1.headers.authorization,
  "local: multipart upload of dictation.webm, no model unless set, no auth header without HIVE_STT_KEY",
);
assert(Buffer.from(await f1!.arrayBuffer()).toString() === "OggS-fake-opus-audio", "local: the audio bytes arrive unchanged");

// ---- OpenAI ----
process.env.HIVE_STT = "openai";
process.env.HIVE_STT_BASE = `${base}/openai/v1`;
process.env.HIVE_STT_MODEL = "my-transcribe-model";
process.env.HIVE_STT_LANGUAGE = "fi";
const r2 = await voice.transcribeFor(db, { audio, mime: "audio/ogg", agent: "alpha", project });
const s2 = seen.at(-1)!;
assert(r2.text === "hello from openai" && s2.headers.authorization === "Bearer sk-test", "openai: Bearer OPENAI_API_KEY, text returned");
assert(s2.form?.get("model") === "my-transcribe-model" && s2.form?.get("language") === "fi" && (s2.form?.get("file") as File).name === "dictation.ogg", "openai: HIVE_STT_MODEL and HIVE_STT_LANGUAGE are sent");
process.env.HIVE_STT_KEY = "wrong";
err = "";
await voice.transcribeFor(db, { audio, mime: "audio/ogg", project }).catch((e) => (err = e.message));
assert(/refused the key \(401\)/.test(err), "openai: HIVE_STT_KEY wins over OPENAI_API_KEY; a refused key is reported");
delete process.env.HIVE_STT_KEY;

// ---- ElevenLabs Scribe ----
process.env.HIVE_STT = "elevenlabs";
delete process.env.HIVE_STT_MODEL;
process.env.ELEVENLABS_API_KEY = "el-test";
process.env.ELEVENLABS_BASE = `${base}/el`;
const r3 = await voice.transcribeFor(db, { audio, mime: "audio/mp4", agent: "beta", project });
const s3 = seen.at(-1)!;
assert(r3.text === "hello from scribe" && s3.headers["xi-api-key"] === "el-test" && s3.form?.get("model_id") === "scribe_v1" && s3.form?.get("language_code") === "fi", "elevenlabs: xi-api-key, model_id and language_code sent");
assert((s3.form?.get("file") as File).name === "dictation.m4a", "elevenlabs: mp4 audio uploaded as .m4a");

// ---- caps ----
const before = seen.length;
err = "";
const big = Buffer.alloc(voice.STT_MAX_BYTES + 10).toString("base64");
await voice.transcribeFor(db, { audio: big, mime: "audio/webm", project }).catch((e) => (err = e.message));
assert(/larger than 25 MB/.test(err) && seen.length === before, "audio over 25 MB is refused before any upload");
err = "";
await voice.transcribeFor(db, { audio, mime: "audio/webm", seconds: 900, project }).catch((e) => (err = e.message));
assert(/longer than 300 s/.test(err) && seen.length === before, "recordings over HIVE_STT_MAX_SECONDS are refused");
err = "";
await voice.transcribeFor(db, { audio, mime: "text/html", project }).catch((e) => (err = e.message));
assert(/unsupported audio type/.test(err), "non-audio MIME types are refused");

// ---- budget + ledger ----
assert(usageSummary(db).media.today === 3, `three transcriptions count toward media_daily (${usageSummary(db).media.today})`);
assert(!usageSummary(db).providers.some((p) => p.provider.startsWith("stt:")), "transcriptions don't show up as token providers");
const cat = ledger.stats("category", {});
const dict = cat.rows.find((r) => r.key === "dictation");
assert(dict?.turns === 3 && dict.tokens === 0, `ledger: 3 dictation calls with 0 tokens (${JSON.stringify(dict)})`);
const kinds = ledger.stats("kind", { category: "dictation" }).rows.map((r) => r.key).sort();
assert(kinds.join() === "stt:elevenlabs,stt:local,stt:openai", `ledger kinds stt:<provider> (${kinds})`);
const vendors = ledger.stats("vendor", { category: "dictation" }).rows.map((r) => r.key).sort();
assert(vendors.join() === "ElevenLabs,Local,OpenAI", `ledger vendors (${vendors})`);
db.setSetting("budget.media_daily", "3");
err = "";
await voice.transcribeFor(db, { audio, mime: "audio/webm", project }).catch((e) => (err = e.message));
assert(/daily media budget reached/.test(err), "the media_daily cap stops dictation too");
db.setSetting("budget.media_daily", "100");

// ---- summarise for speech ----
const reply = `I fixed the login bug in \`src/auth/login.ts\` and added a test.

\`\`\`ts
export function login() { return 42; }
\`\`\`

| file | change |
|------|--------|
| src/auth/login.ts | +12 |

The session token is now refreshed before it expires. See C:\\work\\app\\notes.md for details. All 48 tests pass. I also cleaned up the README.`;
const said = voice.summariseForSpeech(reply);
assert(!/export function|\||login\.ts|notes\.md|```/.test(said), `code blocks, tables and paths stripped: "${said}"`);
assert(said.startsWith("I fixed the login bug"), "speech starts with the first sentence");
assert(said.split(/[.!?]/).filter((x) => x.trim()).length <= 3, `at most three sentences: "${said}"`);
const long = voice.summariseForSpeech("word ".repeat(500));
assert(long.length <= voice.SPEECH_MAX_CHARS && long.endsWith("…"), `capped at ${voice.SPEECH_MAX_CHARS} characters (${long.length})`);
const withSummary = voice.summariseForSpeech("Lots of detail here about many things.\n\n## Summary\nThe build is green and the release is ready to tag.\n\nMore trailing text.");
assert(withSummary === "The build is green and the release is ready to tag.", `a Summary section is preferred: "${withSummary}"`);
assert(voice.summariseForSpeech("```\nonly code\n```") === "", "a reply that is only code says nothing");
const bullets = voice.summariseForSpeech("- **Added** dark mode\n- Fixed [the crash](https://x.y/z)\n- Bumped deps");
assert(bullets === "Added dark mode. Fixed the crash. Bumped deps.", `list items become sentences, markdown and links removed: "${bullets}"`);

// ---- spoken reply through a fake ElevenLabs ----
const sp = await voice.speakFor(db, { agent: "alpha", text: reply, voice: "voice123", project });
const ttsReq = seen.at(-1)!;
assert(sp.audio && Buffer.from(sp.audio, "base64").toString() === "ID3spoken" && (sp as any).mime === "audio/mpeg", "speak returns the mp3 as base64");
assert(ttsReq.url.startsWith("/el/v1/text-to-speech/voice123") && ttsReq.json.text === said && ttsReq.json.text.length <= 400, "only the short summary is sent to ElevenLabs, with the pane's voice");
const nothing = await voice.speakFor(db, { agent: "alpha", text: "```\ncode\n```", project });
assert(nothing.audio === null && seen.at(-1) === ttsReq, "nothing to say: no TTS call");
assert(usageSummary(db).media.today === 4 && ledger.stats("kind", { category: "voice" }).rows[0]?.key === "tts", "a spoken reply counts toward media_daily and in the ledger as tts");
let badVoice = "";
await voice.speakFor(db, { agent: "alpha", text: "Hello there.", voice: "../x", project }).catch((e) => (badVoice = e.message));
assert(/voice must be a voice id/.test(badVoice), "voice ids are validated");

// ---- backend RPCs over stdio ----
const { nodeEntry } = await import("../src/core/paths.js");
const be = nodeEntry("ui/backend");
const proc = spawn(be.command, [...be.args, "--db", join(dir, "be.db"), "--cwd", dir, "--poll", "200"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, HIVE_STT: "local", HIVE_STT_URL: `${base}/local/v1` },
});
const waiting = new Map<number, (m: any) => void>();
let ready = false;
createInterface({ input: proc.stdout! }).on("line", (line) => {
  const m = JSON.parse(line);
  if (typeof m.id === "number") waiting.get(m.id)?.(m);
  else if (m.event === "ready") ready = true;
});
let id = 0;
const call = (method: string, params: unknown): Promise<any> =>
  new Promise((res, rej) => {
    const i = ++id;
    waiting.set(i, (m) => (m.error ? rej(new Error(m.error)) : res(m.result)));
    proc.stdin!.write(JSON.stringify({ id: i, method, params }) + "\n");
  });
await until(() => ready, 20_000, "backend ready");
const st = await call("voiceStatus", {});
assert(st.stt.provider === "local" && st.stt.endpoint === `${base}/local/v1/audio/transcriptions` && st.tts === true && !JSON.stringify(st).includes("el-test") && !JSON.stringify(st).includes("sk-test"), "voiceStatus RPC: provider, endpoint, TTS — and no keys");
const tr = await call("transcribe", { audio, mime: "audio/webm" });
assert(tr.text === "hello from whisper", "transcribe RPC returns the text");
const spk = await call("speak", { agent: "alpha", text: "All done. The tests pass." });
assert(spk.spoken === "All done. The tests pass." && Buffer.from(spk.audio, "base64").toString() === "ID3spoken", "speak RPC returns the spoken text and audio");
proc.stdin!.end();
await new Promise((r) => proc.once("exit", r));

db.close();
ledger.closeLedger();
server.close();
finish("voice");
