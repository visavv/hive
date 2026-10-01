/**
 * Voice for the pane UI: speech-to-text for dictation and short spoken replies.
 * Runs in the UI backend (never in agents), so API keys stay in this process.
 *
 * Speech-to-text providers (HIVE_STT=local|openai|elevenlabs|auto, default auto =
 * the first one configured, in this order):
 *   local       HIVE_STT_URL  an OpenAI-compatible /v1/audio/transcriptions server
 *               (whisper.cpp's whisper-server, speaches / faster-whisper-server …).
 *               Optional HIVE_STT_KEY is sent as a Bearer token.
 *   openai      HIVE_STT_KEY or OPENAI_API_KEY; HIVE_STT_BASE (default https://api.openai.com/v1)
 *   elevenlabs  ELEVENLABS_API_KEY (Scribe); ELEVENLABS_BASE
 * HIVE_STT_MODEL picks the model (local: sent only when set; openai and
 * elevenlabs have a default you can override), HIVE_STT_LANGUAGE an optional
 * language hint (e.g. "en", "fi"), HIVE_STT_MAX_SECONDS the longest clip (default 300).
 *
 * Every transcription and spoken reply counts toward the media_daily budget
 * and is written to the token ledger (kind "stt:<provider>", category
 * "dictation"; kind "tts", category "voice"), with 0 tokens: they are counted
 * in calls ("turns"), not tokens.
 *
 * See docs/VOICE.md.
 */
import type { HiveDb } from "./db.js";
import * as ledger from "../core/ledger.js";
import { checkMediaCap, recordMedia, ttsAudio, ttsAvailable } from "./media.js";

const env = process.env;
export const STT_MAX_BYTES = 25 * 1024 * 1024;
export const SPEECH_MAX_CHARS = 400;
export type SttProvider = "local" | "openai" | "elevenlabs" | "groq" | "nvidia" | "custom";

/**
 * Every dictation provider hive can use. Keys only ever come from the environment;
 * which provider, model and language to use is the owner's choice (setSttPrefs,
 * saved by the backend), falling back to HIVE_STT / HIVE_STT_MODEL / HIVE_STT_LANGUAGE.
 * All but ElevenLabs speak the OpenAI /audio/transcriptions protocol.
 */
export interface SttProviderInfo {
  id: SttProvider;
  label: string;
  /** What has to be set (env var names, shown in the UI). */
  needs: string;
  /** Model suggestions for the picker (free text is allowed; third-party names change). */
  models: string[];
  note: string;
}
export const STT_PROVIDERS: SttProviderInfo[] = [
  { id: "local", label: "Local server (Whisper, Parakeet, …)", needs: "HIVE_STT_URL", models: [], note: "free and private: whisper.cpp server, faster-whisper / speaches, or a Parakeet server on this machine or your LAN/tailnet" },
  { id: "openai", label: "OpenAI", needs: "OPENAI_API_KEY (or HIVE_STT_KEY)", models: ["gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1"], note: "accurate, paid per minute" },
  { id: "elevenlabs", label: "ElevenLabs Scribe", needs: "ELEVENLABS_API_KEY", models: ["scribe_v1"], note: "same key also speaks replies" },
  { id: "groq", label: "Groq (fast hosted Whisper)", needs: "GROQ_API_KEY", models: ["whisper-large-v3-turbo", "whisper-large-v3"], note: "very fast, cheap" },
  { id: "nvidia", label: "NVIDIA (Parakeet / Canary / Nemotron speech)", needs: "HIVE_NVIDIA_STT_URL (self-hosted NIM) or NVIDIA_API_KEY + HIVE_NVIDIA_STT_URL", models: ["parakeet-tdt-0.6b-v2", "canary-1b", "parakeet-ctc-1.1b"], note: "NVIDIA speech models through an OpenAI-compatible NIM endpoint; great on your RTX GPU" },
  { id: "custom", label: "Any OpenAI-compatible service", needs: "HIVE_STT_CUSTOM_URL (+ HIVE_STT_CUSTOM_KEY)", models: [], note: "Deepinfra, Together, Fireworks, a self-hosted gateway…" },
];
const PROVIDERS: SttProvider[] = STT_PROVIDERS.map((p) => p.id);

export interface SttPrefs {
  provider?: SttProvider | "auto";
  model?: string;
  language?: string;
}
let prefs: SttPrefs = {};
/** The owner's saved choice (backend loads it from the db and calls this on change). */
export function setSttPrefs(p: SttPrefs) {
  prefs = { ...p };
}

const sttMaxSeconds = () => Math.max(5, Number(env.HIVE_STT_MAX_SECONDS) || 300);
const openaiKey = () => env.HIVE_STT_KEY || env.OPENAI_API_KEY || "";
const elBase = () => (env.ELEVENLABS_BASE || "https://api.elevenlabs.io").replace(/\/+$/, "");
const trimBase = (u: string) => u.trim().replace(/\/+$/, "");

/** Where a provider's transcription endpoint is and which Bearer key it takes. */
function target(p: SttProvider): { url: string; key: string } | null {
  switch (p) {
    case "local":
      return env.HIVE_STT_URL ? { url: localEndpoint(), key: env.HIVE_STT_KEY ?? "" } : null;
    case "openai":
      return openaiKey() ? { url: `${trimBase(env.HIVE_STT_BASE || "https://api.openai.com/v1")}/audio/transcriptions`, key: openaiKey() } : null;
    case "elevenlabs":
      return env.ELEVENLABS_API_KEY ? { url: `${elBase()}/v1/speech-to-text`, key: env.ELEVENLABS_API_KEY } : null;
    case "groq":
      return env.GROQ_API_KEY ? { url: `${trimBase(env.HIVE_GROQ_BASE || "https://api.groq.com/openai/v1")}/audio/transcriptions`, key: env.GROQ_API_KEY } : null;
    case "nvidia":
      return env.HIVE_NVIDIA_STT_URL ? { url: localEndpoint(env.HIVE_NVIDIA_STT_URL), key: env.NVIDIA_API_KEY ?? "" } : null;
    case "custom":
      return env.HIVE_STT_CUSTOM_URL ? { url: localEndpoint(env.HIVE_STT_CUSTOM_URL), key: env.HIVE_STT_CUSTOM_KEY ?? "" } : null;
  }
}

function configured(p: SttProvider): boolean {
  return !!target(p);
}

/** A server's transcription endpoint from a full URL, a …/v1 base, or just host:port. */
export function localEndpoint(url = env.HIVE_STT_URL ?? ""): string {
  const u = trimBase(url);
  if (/\/audio\/transcriptions$/.test(u)) return u;
  if (/\/v1$/.test(u)) return `${u}/audio/transcriptions`;
  return `${u}/v1/audio/transcriptions`;
}

function defaultModel(p: SttProvider): string | undefined {
  if (prefs.model?.trim()) return prefs.model.trim();
  if (env.HIVE_STT_MODEL) return env.HIVE_STT_MODEL;
  // Third-party model names; pick another in the app (or HIVE_STT_MODEL) when they change.
  if (p === "openai") return "gpt-4o-mini-transcribe";
  if (p === "elevenlabs") return "scribe_v1";
  if (p === "groq") return "whisper-large-v3-turbo";
  return undefined; // local / NVIDIA / custom servers mostly serve one model; send one only if chosen
}
const sttLanguage = () => (prefs.language?.trim() || env.HIVE_STT_LANGUAGE?.trim() || "") || undefined;

export interface SttStatus {
  /** The provider dictation will use, or null when none is set up. */
  provider: SttProvider | null;
  /** What was chosen in the app, else HIVE_STT ("auto" when neither). */
  wanted: string;
  configured: Record<SttProvider, boolean>;
  providers: SttProviderInfo[];
  model?: string;
  language?: string;
  /** Where audio goes (host only, never a key). */
  endpoint?: string;
  maxSeconds: number;
  maxBytes: number;
  /** Why dictation can't work, with what to set. */
  problem?: string;
}

export function sttStatus(): SttStatus {
  const wanted = String(prefs.provider || env.HIVE_STT || "auto").trim().toLowerCase();
  const conf = Object.fromEntries(PROVIDERS.map((p) => [p, configured(p)])) as Record<SttProvider, boolean>;
  let provider: SttProvider | null = null;
  let problem: string | undefined;
  if (wanted === "auto") {
    provider = PROVIDERS.find((p) => conf[p]) ?? null;
    if (!provider) problem = "no speech-to-text provider is set up: set HIVE_STT_URL (a local Whisper/Parakeet server), OPENAI_API_KEY, ELEVENLABS_API_KEY, GROQ_API_KEY or HIVE_NVIDIA_STT_URL, then restart hive (docs/VOICE.md)";
  } else if ((PROVIDERS as string[]).includes(wanted)) {
    provider = wanted as SttProvider;
    if (!conf[provider]) {
      problem = `${STT_PROVIDERS.find((p) => p.id === wanted)!.label} needs ${STT_PROVIDERS.find((p) => p.id === wanted)!.needs} in hive's environment (then restart hive; docs/VOICE.md)`;
      provider = null;
    }
  } else problem = `"${wanted}" is not a dictation provider (${PROVIDERS.join(", ")}, auto)`;
  let endpoint: string | undefined;
  if (provider) {
    try {
      const u = new URL(target(provider)!.url);
      endpoint = `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
      problem = `the ${provider} address is not a URL: ${target(provider)!.url}`;
      provider = null;
    }
  }
  return { provider, wanted, configured: conf, providers: STT_PROVIDERS, model: provider ? defaultModel(provider) : undefined, language: sttLanguage(), endpoint, maxSeconds: sttMaxSeconds(), maxBytes: STT_MAX_BYTES, problem };
}

/** File name with an extension the STT APIs recognise, from a MIME type like "audio/webm;codecs=opus". */
export function audioFileName(mime: string): string {
  const m = mime.split(";")[0].trim().toLowerCase();
  const ext: Record<string, string> = {
    "audio/webm": "webm",
    "video/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/aac": "m4a",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
    "audio/flac": "flac",
  };
  if (!ext[m]) throw new Error(`unsupported audio type ${m || "(none)"}; send webm, ogg, mp4, mp3, wav or flac`);
  return `dictation.${ext[m]}`;
}

async function failText(r: Response, what: string): Promise<never> {
  const t = (await r.text().catch(() => "")).slice(0, 300);
  if (r.status === 401 || r.status === 403) throw new Error(`${what}: the API refused the key (${r.status}). ${t}`);
  if (r.status === 429) throw new Error(`${what}: rate limit / quota reached (429). ${t}`);
  throw new Error(`${what} ${r.status}: ${t}`);
}

/** Send audio to the chosen provider and return the text (no budget or ledger; see transcribeFor). */
export async function transcribe(audio: Buffer, mime: string, provider: SttProvider): Promise<string> {
  if (!audio.length) throw new Error("no audio recorded");
  if (audio.length > STT_MAX_BYTES) throw new Error(`audio is larger than ${STT_MAX_BYTES / 1024 / 1024} MB`);
  const name = audioFileName(mime);
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(audio)], { type: mime.split(";")[0] }), name);
  const model = defaultModel(provider);
  const lang = sttLanguage();
  const t = target(provider);
  if (!t) throw new Error(`${provider} speech-to-text is not set up (docs/VOICE.md)`);
  const url = t.url;
  const headers: Record<string, string> = {};
  if (provider === "elevenlabs") {
    headers["xi-api-key"] = t.key;
    form.set("model_id", model!);
    if (lang) form.set("language_code", lang);
  } else {
    if (t.key) headers.authorization = `Bearer ${t.key}`;
    if (model) form.set("model", model);
    form.set("response_format", "json");
    if (lang) form.set("language", lang);
  }
  const label = `${STT_PROVIDERS.find((p) => p.id === provider)!.label} speech-to-text${["local", "nvidia", "custom"].includes(provider) ? ` (${url})` : ""}`;
  let r: Response;
  try {
    r = await fetch(url, { method: "POST", headers, body: form, signal: AbortSignal.timeout(120_000) });
  } catch (e: any) {
    throw new Error(`${label}: can't reach it (${e?.cause?.code ?? e?.message ?? e})${["local", "nvidia", "custom"].includes(provider) ? " — is the server running?" : ""}`);
  }
  if (!r.ok) await failText(r, label);
  const body = await r.text();
  try {
    const j = JSON.parse(body);
    return String(j.text ?? "").trim();
  } catch {
    return body.trim(); // some servers answer text/plain
  }
}

/** The `transcribe` RPC: size/duration caps, media budget, ledger entry. */
export async function transcribeFor(
  db: HiveDb,
  o: { audio: string; mime: string; seconds?: number; agent?: string; project: string },
): Promise<{ text: string; provider: SttProvider }> {
  const st = sttStatus();
  if (!st.provider) throw new Error(st.problem ?? "speech-to-text is not set up");
  if (typeof o.audio !== "string" || !o.audio) throw new Error("no audio recorded");
  // base64 is 4/3 the size: refuse before decoding a huge string
  if (o.audio.length > Math.ceil((STT_MAX_BYTES * 4) / 3) + 4) throw new Error(`audio is larger than ${STT_MAX_BYTES / 1024 / 1024} MB`);
  if (o.seconds !== undefined && o.seconds > st.maxSeconds + 2) throw new Error(`recording is longer than ${st.maxSeconds} s (HIVE_STT_MAX_SECONDS)`);
  const buf = Buffer.from(o.audio, "base64");
  checkMediaCap(db, 1);
  const text = await transcribe(buf, o.mime || "audio/webm", st.provider);
  const agent = o.agent || "owner";
  db.recordUsage(agent, `stt:${st.provider}`, 0);
  try {
    ledger.record({ project: o.project, agent, kind: `stt:${st.provider}`, model: st.model, category: "dictation", tokens: 0 });
  } catch {}
  return { text, provider: st.provider };
}

// ---- spoken replies ----

const P = "\u2063"; // stands in for a removed path / link while sentences are cut
const PREP = new RegExp(`\\s*\\b(?:in|at|to|from|under|inside|into|on|of)\\s*${P}(?:\\s*(?:,|and)\\s*${P})*`, "gi");

/**
 * What to say out loud for an agent's reply: no code blocks, tables, paths,
 * links or markdown; the first two or three sentences (or a "Summary"
 * paragraph if there is one), at most `max` characters.
 */
export function summariseForSpeech(md: string, max = SPEECH_MAX_CHARS): string {
  let t = md.replace(/\r\n?/g, "\n");
  t = t.replace(/```[\s\S]*?(```|$)/g, "\n\n"); // fenced code (an unclosed fence runs to the end)
  t = t.replace(/~~~[\s\S]*?(~~~|$)/g, "\n\n");
  t = t
    .split("\n")
    .filter((l) => !/^\s*\|.*\|\s*$/.test(l) && !/^\s*\|?\s*:?-{3,}/.test(l) && !/^( {4}|\t)/.test(l)) // tables, indented code
    .join("\n");
  // A "Summary" / "TL;DR" section says it best.
  const sum = t.match(/(?:^|\n)\s*(?:#+\s*|\*\*)?(?:summary|tl;?dr|in short)\b[:*\s]*\**\s*:?\s*\n?([^\n][\s\S]*?)(?:\n\s*\n|$)/i);
  if (sum && sum[1].trim().length > 20) t = sum[1];
  t = t
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → their text
    .replace(/<[^>]+>/g, "")
    .replace(/https?:\/\/\S+/g, P)
    .replace(/`([^`]*)`/g, (_m, c: string) => (/[\\/]|\.\w{1,5}$|[(){};=<>]/.test(c) || c.length > 30 ? P : c)) // inline code: keep short words
    .replace(/(?:[A-Za-z]:)?(?:[\w.-]*[\\/])+[\w.-]+(?::\d+(?::\d+)?)?/g, P) // paths (src/a/b.ts:12, C:\x\y)
    .replace(/\b[\w-]+\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|cs|cpp|c|h|rb|php|json|ya?ml|toml|lock|css|html|sh|ps1|sql)\b(?::\d+)?/g, P) // bare file names
    .replace(/^\s{0,3}#{1,6}\s*/gm, "") // headings
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "") // list markers
    .replace(/^\s*>\s?/gm, "")
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([^\n]*?\S)\1/g, "$2") // emphasis
    .replace(/[*_#>|`]/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]+([,.;:!?])/g, "$1")
    .replace(/\n{2,}/g, "\n")
    .replace(/[ \t]{2,}/g, " ");
  // Lines become sentences (list items rarely end in a full stop).
  const sentences = t
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /[A-Za-z0-9\u00C0-\uFFFF]/.test(l))
    .map((l) => (/[.!?:…]$/.test(l) ? l : l + "."))
    .join(" ")
    .match(/\S.*?(?:[.!?…]+(?=\s|$)|$)/g)
    ?.map((s) => s.trim())
    // "in <path>" → dropped; a sentence still pointing at a removed path ("See <path> for details") is dropped whole
    .map((s) => s.replace(PREP, "").trim())
    .filter((s) => s.length > 1 && !s.includes(P) && /[A-Za-z0-9\u00C0-\uFFFF]/.test(s)) ?? [];
  let out = "";
  for (const s of sentences.slice(0, 3)) {
    const next = out ? `${out} ${s}` : s;
    if (next.length > max) break;
    out = next;
  }
  if (!out && sentences[0]) {
    // one long sentence: cut at a word boundary
    const cut = sentences[0].slice(0, max - 1);
    out = cut.slice(0, Math.max(cut.lastIndexOf(" "), max / 2)).replace(/[,;:\s]+$/, "") + "…";
  }
  return out.replace(/\s+/g, " ").trim();
}

/** The `speak` RPC: summarise, check the budget, ask ElevenLabs, return mp3 as base64. */
export async function speakFor(
  db: HiveDb,
  o: { text: string; voice?: string; agent: string; project: string; raw?: boolean },
): Promise<{ audio: string; mime: string; spoken: string } | { audio: null; spoken: "" }> {
  if (!ttsAvailable()) throw new Error("spoken replies need ELEVENLABS_API_KEY (docs/VOICE.md)");
  const spoken = o.raw ? String(o.text ?? "").trim().slice(0, SPEECH_MAX_CHARS) : summariseForSpeech(String(o.text ?? ""));
  if (!spoken) return { audio: null, spoken: "" };
  checkMediaCap(db, 1);
  const buf = await ttsAudio({ text: spoken, voice: o.voice });
  recordMedia(db, o.agent, "tts");
  try {
    ledger.record({ project: o.project, agent: o.agent, kind: "tts", category: "voice", tokens: 0 });
  } catch {}
  return { audio: buf.toString("base64"), mime: "audio/mpeg", spoken };
}
