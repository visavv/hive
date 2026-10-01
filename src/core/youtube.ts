/**
 * YouTube links as skill input: wherever a skill takes a transcript file you
 * can paste a video link instead, and hive fetches the captions.
 *
 *   1. yt-dlp, if it's installed (most robust when YouTube changes things)
 *   2. otherwise YouTube's own player API + caption track (no key needed)
 *
 * Results are cached per video and language under <HIVE_HOME>/cache/youtube/.
 * HIVE_YT_BASE overrides https://www.youtube.com (tests); HIVE_YT_DLP=0 skips yt-dlp.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hiveHome } from "./home.js";

/** Video id from a YouTube URL (watch, youtu.be, shorts, live, embed), or undefined. */
export function youtubeId(s: string): string | undefined {
  const t = s.trim();
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return undefined;
  }
  const host = u.hostname.replace(/^(www|m|music)\./, "");
  let id: string | null | undefined;
  if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0];
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    id = u.searchParams.get("v") ?? u.pathname.match(/^\/(?:shorts|live|embed|v)\/([\w-]{11})/)?.[1];
  }
  return id && /^[\w-]{11}$/.test(id) ? id : undefined;
}

const base = () => (process.env.HIVE_YT_BASE ?? "https://www.youtube.com").replace(/\/+$/, "");

export interface Transcript {
  id: string;
  title?: string;
  channel?: string;
  lang: string;
  auto: boolean;
  text: string;
}

const stamp = (sec: number) => {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

const decode = (s: string) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, " ")
    .trim();

/** Timed-text XML (<text start dur>) → "[m:ss] line" lines. */
export function parseTimedText(xml: string): string {
  const out: string[] = [];
  for (const m of xml.matchAll(/<(?:text|p)\b([^>]*)>([\s\S]*?)<\/(?:text|p)>/g)) {
    const attrs = m[1];
    const start = Number(attrs.match(/\bstart="([\d.]+)"/)?.[1] ?? Number(attrs.match(/\bt="(\d+)"/)?.[1] ?? 0) / 1000);
    const line = decode(m[2]);
    if (line && out.at(-1)?.endsWith(line) !== true) out.push(`[${stamp(start)}] ${line}`);
  }
  return out.join("\n");
}

/** WebVTT → "[m:ss] line" lines (auto captions repeat lines; drop the repeats). */
export function parseVtt(vtt: string): string {
  const out: string[] = [];
  let last = "";
  for (const block of vtt.replace(/\r/g, "").split(/\n\n+/)) {
    const m = block.match(/(\d+:)?(\d+):(\d+)\.\d+\s+-->/);
    if (!m) continue;
    const sec = Number(m[1] ? m[1].slice(0, -1) : 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    const text = decode(block.split("\n").filter((l) => !l.includes("-->") && !/^\d+$/.test(l.trim())).join(" "));
    if (!text || text === last) continue;
    // Rolling auto captions: keep only the new tail.
    const fresh = last && text.startsWith(last) ? text.slice(last.length).trim() : text;
    last = text;
    if (fresh) out.push(`[${stamp(sec)}] ${fresh}`);
  }
  return out.join("\n");
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  return new Promise((res) =>
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 20_000_000 }, (err, stdout, stderr) => res({ ok: !err, out: String(stdout) + String(stderr) })),
  );
}

async function viaYtDlp(id: string, lang: string): Promise<Transcript | undefined> {
  if (process.env.HIVE_YT_DLP === "0") return undefined;
  const probe = await run("yt-dlp", ["--version"], 10_000);
  if (!probe.ok) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "hive-yt-"));
  try {
    const url = `https://www.youtube.com/watch?v=${id}`;
    const r = await run(
      "yt-dlp",
      ["--skip-download", "--write-subs", "--write-auto-subs", "--sub-langs", `${lang}.*,${lang},en.*,en`, "--sub-format", "vtt", "--print", "%(title)s\t%(channel)s", "--no-simulate", "-o", join(dir, "%(id)s"), url],
      120_000,
    );
    const files = readdirSync(dir).filter((f) => f.endsWith(".vtt"));
    if (!files.length) return undefined;
    const pick = files.find((f) => f.includes(`.${lang}`)) ?? files[0];
    const [title, channel] = r.out.split("\n")[0]?.split("\t") ?? [];
    return { id, title, channel, lang: pick.split(".").slice(-2, -1)[0] ?? lang, auto: false, text: parseVtt(readFileSync(join(dir, pick), "utf8")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function viaPlayerApi(id: string, lang: string): Promise<Transcript> {
  const headers = { "content-type": "application/json", "accept-language": `${lang},en;q=0.8`, "user-agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 14)" };
  const r = await fetch(`${base()}/youtubei/v1/player?prettyPrint=false`, {
    method: "POST",
    headers,
    body: JSON.stringify({ context: { client: { clientName: "ANDROID", clientVersion: "20.10.38", hl: lang } }, videoId: id }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`YouTube answered ${r.status}`);
  const j: any = await r.json();
  const status = j.playabilityStatus?.status;
  if (status && status !== "OK") throw new Error(`YouTube says the video isn't available (${j.playabilityStatus?.reason ?? status})`);
  const tracks: any[] = j.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  if (!tracks.length) throw new Error("this video has no captions YouTube will share");
  const manual = tracks.filter((t) => t.kind !== "asr");
  const track =
    manual.find((t) => t.languageCode === lang) ?? tracks.find((t) => t.languageCode === lang) ?? manual.find((t) => t.languageCode?.startsWith("en")) ?? manual[0] ?? tracks[0];
  const url = String(track.baseUrl).replace(/&fmt=[^&]*/, "");
  const cap = await fetch(url.startsWith("http") ? url : base() + url, { headers: { "accept-language": headers["accept-language"] }, signal: AbortSignal.timeout(20_000) });
  if (!cap.ok) throw new Error(`caption download failed (${cap.status})`);
  const text = parseTimedText(await cap.text());
  if (!text) throw new Error("the caption track was empty (YouTube may have blocked the request)");
  return { id, title: j.videoDetails?.title, channel: j.videoDetails?.author, lang: track.languageCode, auto: track.kind === "asr", text };
}

/** Captions for a video, cached. Throws with advice when YouTube won't give them. */
export async function fetchTranscript(id: string, lang = "en"): Promise<Transcript> {
  const dir = join(hiveHome(), "cache", "youtube");
  const file = join(dir, `${id}.${lang}.json`);
  if (existsSync(file)) {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {}
  }
  let t: Transcript | undefined;
  let err = "";
  try {
    t = await viaYtDlp(id, lang);
  } catch (e: any) {
    err = String(e?.message ?? e);
  }
  if (!t) {
    try {
      t = await viaPlayerApi(id, lang);
    } catch (e: any) {
      err = String(e?.message ?? e);
    }
  }
  if (!t)
    throw new Error(
      `couldn't get captions for ${id}: ${err}. Options: install yt-dlp (winget install yt-dlp / dnf install yt-dlp), or download the subtitles (.srt) from YouTube Studio → Subtitles and pass the file instead.`,
    );
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(t));
  return t;
}

/** Fetch a transcript and save it as a text file a skill can read; returns its path. */
export async function transcriptFile(url: string, lang = "en"): Promise<string> {
  const id = youtubeId(url);
  if (!id) throw new Error(`not a YouTube link: ${url}`);
  const t = await fetchTranscript(id, lang);
  const dir = join(hiveHome(), "cache", "youtube");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.${t.lang}.txt`);
  const head = [t.title && `Title: ${t.title}`, t.channel && `Channel: ${t.channel}`, `Video: https://youtu.be/${id}`, `Captions: ${t.lang}${t.auto ? " (auto-generated)" : ""}`]
    .filter(Boolean)
    .join("\n");
  writeFileSync(path, `${head}\n\n${t.text}\n`);
  return path;
}
