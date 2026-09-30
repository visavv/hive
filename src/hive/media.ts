/**
 * Media APIs agents (and you, via `hive tts` / `hive image`) can call:
 *   text → speech   ElevenLabs                     ELEVENLABS_API_KEY
 *   image generate  any OpenAI-compatible images API   HIVE_IMAGE_KEY or OPENAI_API_KEY
 *   image edit      same (input image + optional mask)
 *
 * Results are saved under <folder>/out/media/. Input files must be inside the
 * folder. Every call counts toward the media_daily budget (default 40/day),
 * and as hive tools outside the always-allowed set they go through the
 * agent's permission policy (so "ask" / "allow-reads" agents ask you first).
 *
 * Env overrides: ELEVENLABS_BASE, ELEVENLABS_VOICE, ELEVENLABS_MODEL,
 * HIVE_IMAGE_BASE (default https://api.openai.com/v1), HIVE_IMAGE_MODEL (default gpt-image-1).
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { HiveDb } from "./db.js";
import { budgetSetting, startOfToday } from "../core/budget.js";

const env = process.env;
const MAX_IMAGE = 20_000_000;
const MAX_TTS_CHARS = 10_000;

export const ttsAvailable = () => !!env.ELEVENLABS_API_KEY;
export const imageAvailable = () => !!(env.HIVE_IMAGE_KEY || env.OPENAI_API_KEY);
const imageKey = () => env.HIVE_IMAGE_KEY || env.OPENAI_API_KEY || "";
const imageBase = () => (env.HIVE_IMAGE_BASE || "https://api.openai.com/v1").replace(/\/+$/, "");
const elBase = () => (env.ELEVENLABS_BASE || "https://api.elevenlabs.io").replace(/\/+$/, "");

/** Throws when today's media budget is used up; otherwise records one call. */
export function chargeMedia(db: HiveDb, agent: string, kind: "tts" | "image") {
  const cap = Number(budgetSetting(db, "media_daily") ?? "40");
  const used = db
    .usageSince(startOfToday())
    .filter((u) => u.provider.startsWith("media:"))
    .reduce((n, u) => n + u.turns, 0);
  if (cap >= 0 && used >= cap) throw new Error(`daily media budget reached (${used}/${cap}); raise it with hive budget set media_daily=N`);
  db.recordUsage(agent, `media:${kind}`, 0);
}

export function insideFolder(cwd: string, p: string): string {
  const abs = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
  const rel = relative(resolve(cwd), abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${p} is outside the working folder`);
  return abs;
}

function outFile(cwd: string, name: string | undefined, fallback: string, ext: string): string {
  const slug =
    (name ? basename(name, extname(name)) : fallback)
      .toLowerCase()
      .replace(/[^\w-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "media";
  const dir = join(resolve(cwd), "out", "media");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return join(dir, `${stamp}-${slug}${ext}`);
}

async function failText(r: Response, what: string): Promise<never> {
  const t = (await r.text().catch(() => "")).slice(0, 400);
  if (r.status === 401 || r.status === 403) throw new Error(`${what}: the API refused the key (${r.status}). ${t}`);
  if (r.status === 429) throw new Error(`${what}: rate limit / quota reached (429). ${t}`);
  throw new Error(`${what} ${r.status}: ${t}`);
}

export async function tts(o: { cwd: string; text: string; voice?: string; model?: string; name?: string }): Promise<{ path: string; bytes: number }> {
  if (!ttsAvailable()) throw new Error("ELEVENLABS_API_KEY is not set");
  const text = o.text.trim();
  if (!text) throw new Error("text is empty");
  if (text.length > MAX_TTS_CHARS) throw new Error(`text is longer than ${MAX_TTS_CHARS} characters; split it`);
  const voice = o.voice || env.ELEVENLABS_VOICE || "21m00Tcm4TlvDq8ikWAM";
  if (!/^[\w-]{1,64}$/.test(voice)) throw new Error("voice must be a voice id (hive_voices lists them)");
  const r = await fetch(`${elBase()}/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY!, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: o.model || env.ELEVENLABS_MODEL || "eleven_multilingual_v2" }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!r.ok) await failText(r, "ElevenLabs");
  const buf = Buffer.from(await r.arrayBuffer());
  const path = outFile(o.cwd, o.name, text.slice(0, 40), ".mp3");
  writeFileSync(path, buf);
  return { path, bytes: buf.length };
}

export async function voices(): Promise<{ id: string; name: string; labels?: string }[]> {
  if (!ttsAvailable()) throw new Error("ELEVENLABS_API_KEY is not set");
  const r = await fetch(`${elBase()}/v1/voices`, { headers: { "xi-api-key": env.ELEVENLABS_API_KEY! }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) await failText(r, "ElevenLabs");
  const j: any = await r.json();
  return (j.voices ?? []).map((v: any) => ({ id: v.voice_id, name: v.name, labels: v.labels ? Object.values(v.labels).join(", ") : undefined }));
}

async function saveImages(j: any, cwd: string, name: string | undefined, fallback: string): Promise<string[]> {
  const out: string[] = [];
  for (const d of j.data ?? []) {
    let buf: Buffer | undefined;
    if (d.b64_json) buf = Buffer.from(d.b64_json, "base64");
    else if (typeof d.url === "string" && d.url.startsWith("https://")) {
      const r = await fetch(d.url, { signal: AbortSignal.timeout(60_000) });
      if (r.ok) buf = Buffer.from(await r.arrayBuffer());
    }
    if (!buf) continue;
    const p = outFile(cwd, name, fallback, out.length ? `-${out.length + 1}.png` : ".png");
    writeFileSync(p, buf);
    out.push(p);
  }
  if (!out.length) throw new Error(`the images API returned no image: ${JSON.stringify(j).slice(0, 300)}`);
  return out;
}

const SIZES = ["1024x1024", "1536x1024", "1024x1536", "auto"];

export async function imageGenerate(o: { cwd: string; prompt: string; size?: string; n?: number; name?: string; model?: string }): Promise<string[]> {
  if (!imageAvailable()) throw new Error("set HIVE_IMAGE_KEY (or OPENAI_API_KEY) to generate images");
  if (!o.prompt.trim()) throw new Error("prompt is empty");
  if (o.size && !SIZES.includes(o.size)) throw new Error(`size must be one of ${SIZES.join(", ")}`);
  const r = await fetch(`${imageBase()}/images/generations`, {
    method: "POST",
    headers: { authorization: `Bearer ${imageKey()}`, "content-type": "application/json" },
    body: JSON.stringify({ model: o.model || env.HIVE_IMAGE_MODEL || "gpt-image-1", prompt: o.prompt, n: Math.max(1, Math.min(4, o.n ?? 1)), ...(o.size ? { size: o.size } : {}) }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!r.ok) await failText(r, "images API");
  return saveImages(await r.json(), o.cwd, o.name, o.prompt.slice(0, 40));
}

function imageBlob(path: string): Blob {
  const ext = extname(path).toLowerCase();
  const type = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "";
  if (!type) throw new Error(`${basename(path)}: use a .png, .jpg or .webp image`);
  if (statSync(path).size > MAX_IMAGE) throw new Error(`${basename(path)} is larger than 20 MB`);
  return new Blob([readFileSync(path)], { type });
}

export async function imageEdit(o: { cwd: string; image: string; prompt: string; mask?: string; size?: string; name?: string; model?: string }): Promise<string[]> {
  if (!imageAvailable()) throw new Error("set HIVE_IMAGE_KEY (or OPENAI_API_KEY) to edit images");
  if (!o.prompt.trim()) throw new Error("prompt is empty");
  if (o.size && !SIZES.includes(o.size)) throw new Error(`size must be one of ${SIZES.join(", ")}`);
  const img = insideFolder(o.cwd, o.image);
  const form = new FormData();
  form.set("model", o.model || env.HIVE_IMAGE_MODEL || "gpt-image-1");
  form.set("prompt", o.prompt);
  form.set("image", imageBlob(img), basename(img));
  if (o.mask) {
    const m = insideFolder(o.cwd, o.mask);
    form.set("mask", imageBlob(m), basename(m));
  }
  if (o.size) form.set("size", o.size);
  const r = await fetch(`${imageBase()}/images/edits`, { method: "POST", headers: { authorization: `Bearer ${imageKey()}` }, body: form, signal: AbortSignal.timeout(300_000) });
  if (!r.ok) await failText(r, "images API");
  return saveImages(await r.json(), o.cwd, o.name ?? `${basename(img, extname(img))}-edit`, o.prompt.slice(0, 40));
}

/** Kinds this process can run (it has the keys). */
export function mediaKinds(): string[] {
  return [...(ttsAvailable() ? ["tts", "voices"] : []), ...(imageAvailable() ? ["image"] : [])];
}

/** Run one media request from an agent. `cwd` is the agent's folder as the hub knows it. */
export async function runMedia(db: HiveDb, agent: string, cwd: string, kind: string, p: any): Promise<string> {
  if (kind === "voices") return JSON.stringify(await voices(), null, 1);
  chargeMedia(db, agent, kind === "tts" ? "tts" : "image");
  if (kind === "tts") {
    const r = await tts({ cwd, text: String(p.text ?? ""), voice: p.voice, name: p.name });
    return `saved ${r.path} (${Math.round(r.bytes / 1024)} KB)`;
  }
  if (kind === "image") {
    const files = p.edit
      ? await imageEdit({ cwd, image: String(p.image ?? ""), prompt: String(p.prompt ?? ""), mask: p.mask, size: p.size, name: p.name })
      : await imageGenerate({ cwd, prompt: String(p.prompt ?? ""), size: p.size, n: p.n, name: p.name });
    return `saved:\n${files.join("\n")}`;
  }
  throw new Error(`unknown media kind ${kind}`);
}
