/**
 * Media tools: an agent calls hive_tts / hive_image / hive_image_edit; the hub
 * (which holds the keys) runs the call against fake ElevenLabs / images APIs on
 * 127.0.0.1 and saves files under out/media/. Budget, path limits, key isolation.
 */
import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assert, finish, freshDir } from "./util.js";
import { usageSummary } from "../src/core/budget.js";

const dir = freshDir(".hive-test-media");
const work = join(dir, "work");
freshDir(work);
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
writeFileSync(join(work, "thumb.png"), PNG);

const seen: { url: string; headers: any; body: string }[] = [];
const server = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  seen.push({ url: req.url!, headers: req.headers, body });
  if (req.url!.startsWith("/v1/text-to-speech/")) {
    if (req.headers["xi-api-key"] !== "el-test") return res.writeHead(401).end("bad key");
    return res.writeHead(200, { "content-type": "audio/mpeg" }).end(Buffer.from("ID3fakeaudio"));
  }
  if (req.url === "/v1/voices") return res.writeHead(200).end(JSON.stringify({ voices: [{ voice_id: "v1", name: "Narrator", labels: { accent: "finnish" } }] }));
  if (req.url === "/v1/images/generations" || req.url === "/v1/images/edits") {
    if (req.headers.authorization !== "Bearer img-test") return res.writeHead(401).end("bad key");
    return res.writeHead(200).end(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }));
  }
  res.writeHead(404).end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
Object.assign(process.env, { ELEVENLABS_API_KEY: "el-test", ELEVENLABS_BASE: base, HIVE_IMAGE_KEY: "img-test", HIVE_IMAGE_BASE: `${base}/v1` });

// import after env is set: the hub decides at startup which media tools it can run
const { Hub } = await import("../src/core/hub.js");
const hub = new Hub({ hiveDb: join(dir, "hive.db"), pollMs: 200 });
const a = await hub.add({ name: "studio", agent: "mock", cwd: work, policy: "allow-all" });

await a.runOnce('calltool hive_tts {"text":"Welcome back to the channel","name":"intro"}', { automatic: false });
const media = () => (existsSync(join(work, "out/media")) ? readdirSync(join(work, "out/media")) : []);
const mp3 = media().find((f) => f.endsWith("-intro.mp3"));
assert(mp3 && readFileSync(join(work, "out/media", mp3), "utf8") === "ID3fakeaudio", `hive_tts saved an mp3 (${a.lastReply.trim().slice(0, 120)})`);
assert(JSON.parse(seen.find((s) => s.url.startsWith("/v1/text-to-speech"))!.body).text === "Welcome back to the channel", "text sent to ElevenLabs");

await a.runOnce("calltool hive_voices {}", { automatic: false });
assert(a.lastReply.includes("Narrator"), "hive_voices lists voices");

await a.runOnce('calltool hive_image {"prompt":"a bold thumbnail","size":"1536x1024","name":"thumb draft"}', { automatic: false });
assert(media().some((f) => f.endsWith("-thumb-draft.png")), "hive_image saved a png");
assert(JSON.parse(seen.find((s) => s.url === "/v1/images/generations")!.body).size === "1536x1024", "size passed to the images API");

await a.runOnce('calltool hive_image_edit {"image":"thumb.png","prompt":"make the text red"}', { automatic: false });
assert(media().some((f) => f.endsWith("-thumb-edit.png")) && seen.some((s) => s.url === "/v1/images/edits" && s.body.includes("make the text red")), "hive_image_edit uploads the image and saves a new png");
assert(readFileSync(join(work, "thumb.png")).equals(PNG), "the original image is untouched");

await a.runOnce('calltool hive_image_edit {"image":"../../etc/hosts","prompt":"x"}', { automatic: false });
assert(/outside the working folder/.test(a.lastReply), "images outside the folder are refused");

// keys stay in the hub process: the agent's environment doesn't have them
const pid = a.pid!;
let agentEnv = "";
try {
  agentEnv = readFileSync(`/proc/${pid}/environ`, "utf8");
} catch {}
if (agentEnv) assert(!agentEnv.includes("el-test") && !agentEnv.includes("img-test"), "media API keys are not in the agent's environment");

// daily media budget
assert(usageSummary(hub.db).media.today === 3, `only successful calls count toward the media budget (${usageSummary(hub.db).media.today})`);
hub.db.setSetting("budget.media_daily", "3");
await a.runOnce('calltool hive_tts {"text":"one more"}', { automatic: false });
assert(/daily media budget reached/.test(a.lastReply), `media_daily caps calls (${a.lastReply.trim().slice(-120)})`);

// the cap counts images, and media jobs still running hold their slots
hub.db.setSetting("budget.media_daily", "5");
await a.runOnce('calltool hive_image {"prompt":"four at once","n":4}', { automatic: false });
assert(/daily media budget reached.*4 asked/.test(a.lastReply), `hive_image n=4 counts as 4 calls (${a.lastReply.trim().slice(-120)})`);
const { checkMediaCap } = await import("../src/hive/media.js");
hub.db.setSetting("budget.media_daily", "4"); // 3 used: one slot left
const first = hub.db.addMedia("studio", "tts", {});
const second = hub.db.addMedia("studio", "tts", {});
hub.db.db.prepare("UPDATE media_jobs SET status='running' WHERE id IN (?,?)").run(first, second);
let capErr = "";
try {
  checkMediaCap(hub.db, 1, second);
} catch (e: any) {
  capErr = e.message;
}
let firstOk = true;
try {
  checkMediaCap(hub.db, 1, first);
} catch {
  firstOk = false;
}
assert(firstOk && /1 in progress/.test(capErr), "two jobs at cap-1: the earlier one takes the last slot, the later one is refused");
hub.db.finishMedia(first, "x", null);
hub.db.finishMedia(second, "x", null);

// bad key → clear message
hub.db.setSetting("budget.media_daily", "100");
process.env.ELEVENLABS_API_KEY = "wrong";
await a.runOnce('calltool hive_tts {"text":"hi"}', { automatic: false });
assert(/refused the key/.test(a.lastReply), "a rejected key is reported");

await hub.close();
server.close();
finish("media");
