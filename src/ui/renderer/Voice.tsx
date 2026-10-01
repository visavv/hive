/**
 * Voice in the pane UI (docs/VOICE.md):
 *   dictation       mic button on every composer and the broadcast box, plus a
 *                   push-to-talk key (hold to talk, tap to toggle). Audio is
 *                   recorded here (MediaRecorder) and sent to the backend's
 *                   `transcribe` RPC, which holds the provider key.
 *   spoken replies  per pane: when its agent finishes a turn the backend speaks a
 *                   short summary (ElevenLabs) and this plays it (Web Audio, no
 *                   URLs, so the page's CSP stays shut). Esc or a click stops it.
 *   conversation    "Talk with <agent>": dictation sends at once, replies are
 *                   spoken, then it listens again until ~1.5 s of silence.
 * Works the same over the Electron bridge and the web bridge: it only calls rpc().
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PaneVoice, VoiceSettings, VoiceStatusView } from "../protocol.js";
import { rpc } from "./bridge.js";
import { onTurnEnd, store, useStore } from "./store.js";
import { focus, overlays, useOverlay } from "./focus.js";
import { saveLayout } from "./App.js";
import type { PaletteAction } from "./Palette.js";

export const VOICE_DOCS = "https://github.com/visavv/hargent/blob/main/docs/VOICE.md";
const BROADCAST = "@broadcast";

// ---- tiny observable for voice UI state ----

let version = 0;
const subs = new Set<() => void>();
function emit() {
  version++;
  for (const s of subs) s();
}
function useVoice<T>(select: () => T): T {
  useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
    () => version,
  );
  return select();
}

// ---- settings ----

export const voiceSettings = (): VoiceSettings => store.layout.voice ?? {};
function setVoiceSettings(patch: Partial<VoiceSettings>) {
  saveLayout({ voice: { ...voiceSettings(), ...patch } });
}
export const paneVoice = (name: string): PaneVoice => store.layout.panes.find((p) => p.name === name)?.voice ?? {};
export function setPaneVoice(name: string, patch: Partial<PaneVoice>) {
  const panes = store.layout.panes.map((p) => (p.name === name ? { ...p, voice: { ...p.voice, ...patch } } : p));
  saveLayout({ panes });
  emit();
}
const pttKey = () => voiceSettings().pttKey ?? "ctrl+shift+space";
const PTT_LABEL: Record<NonNullable<VoiceSettings["pttKey"]>, string> = {
  "ctrl+shift+space": "Ctrl+Shift+Space",
  "ctrl+space": "Ctrl+Space",
  "alt+shift+space": "Alt+Shift+Space",
  f9: "F9",
  off: "off",
};
export const pttLabel = () => PTT_LABEL[pttKey()];

// ---- provider status ----

let status: VoiceStatusView | null = null;
let statusLoading: Promise<VoiceStatusView | null> | undefined;
export function loadVoiceStatus(force = false): Promise<VoiceStatusView | null> {
  if (status && !force) return Promise.resolve(status);
  statusLoading ??= rpc("voiceStatus", {})
    .then((s) => {
      status = s;
      emit();
      return s;
    })
    .catch(() => null)
    .finally(() => (statusLoading = undefined));
  return statusLoading;
}

// ---- dictation targets (pane composers, the broadcast box) ----

export interface VoiceTarget {
  el: () => HTMLTextAreaElement | HTMLInputElement | null;
  setText: (v: string) => void;
  send: (text: string) => void;
}
const targets = new Map<string, VoiceTarget>();

/** Register a text box as a dictation target while mounted. */
export function useVoiceTarget(name: string, t: VoiceTarget) {
  const ref = useRef(t);
  ref.current = t;
  useEffect(() => {
    const proxy: VoiceTarget = { el: () => ref.current.el(), setText: (v) => ref.current.setText(v), send: (x) => ref.current.send(x) };
    targets.set(name, proxy);
    return () => {
      if (targets.get(name) === proxy) targets.delete(name);
    };
  }, [name]);
}

/** Put text at the cursor (spaces around it as needed); returns the new value. */
export function insertAtCursor(value: string, start: number, end: number, text: string): { value: string; caret: number } {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const pre = before && !/\s$/.test(before) ? " " : "";
  const post = after && !/^\s/.test(after) ? " " : "";
  const head = before + pre + text;
  return { value: head + post + after, caret: head.length };
}

function deliver(target: string, text: string) {
  const t = targets.get(target);
  if (!t) return store.toast(`dictated text had nowhere to go: ${text}`, "error");
  const el = t.el();
  const cur = el?.value ?? "";
  const focused = el && document.activeElement === el;
  const { value, caret } = insertAtCursor(cur, focused ? (el.selectionStart ?? cur.length) : cur.length, focused ? (el.selectionEnd ?? cur.length) : cur.length, text);
  const sendNow = voiceSettings().sendAfter || (target !== BROADCAST && paneVoice(target).talk);
  if (sendNow) {
    t.send(value);
    return;
  }
  t.setText(value);
  requestAnimationFrame(() => {
    if (!el?.isConnected) return;
    if (target !== BROADCAST) focus.to(target);
    else el.focus();
    el.setSelectionRange(caret, caret);
  });
}

// ---- recording ----

type Mode = "hold" | "toggle" | "vad";
interface Rec {
  target: string;
  phase: "starting" | "recording" | "transcribing";
  mode: Mode;
  startedAt: number;
  level: number;
  heard: boolean;
}
let rec: Rec | null = null;
let live:
  | { stream: MediaStream; recorder: MediaRecorder; chunks: Blob[]; ctx: AudioContext; timer: ReturnType<typeof setInterval>; mime: string; stopped: Promise<void> }
  | undefined;
let token = 0;
/** A hold-to-talk key was released while the mic was still opening. */
let stopWhenReady = false;

export const recording = () => rec;

function pickMime(): string {
  const all = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  try {
    return all.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
  } catch {
    return "";
  }
}

const SILENCE_MS = 1500;
const NO_SPEECH_MS = 8000;

/** Open the mic for `target`. Clicking/pressing again (or silence, in "vad" mode) stops it. */
export async function startDictation(target: string, mode: Mode = "toggle") {
  if (rec) {
    if (rec.target === target && rec.phase === "recording") return stopDictation();
    if (rec.phase === "transcribing") return;
    cancelDictation();
  }
  stopSpeech();
  unlockAudio();
  const my = ++token;
  rec = { target, phase: "starting", mode, startedAt: Date.now(), level: 0, heard: false };
  stopWhenReady = false;
  emit();
  const st = await loadVoiceStatus();
  if (my !== token) return;
  if (!st?.stt.provider) {
    rec = null;
    emit();
    openSetup();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    rec = null;
    emit();
    store.toast("this browser can't record audio here (a phone browser needs https or localhost for the microphone)", "error");
    return;
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e: any) {
    if (my === token) {
      rec = null;
      emit();
      store.toast(`microphone: ${e?.name === "NotAllowedError" ? "permission denied" : e?.name === "NotFoundError" ? "no microphone found" : (e?.message ?? e)}`, "error");
    }
    return;
  }
  if (my !== token) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  const mime = pickMime();
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  } catch (e: any) {
    stream.getTracks().forEach((t) => t.stop());
    rec = null;
    emit();
    store.toast(`can't record: ${e?.message ?? e}`, "error");
    return;
  }
  const chunks: Blob[] = [];
  recorder.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);
  const stopped = new Promise<void>((r) => (recorder.onstop = () => r()));
  recorder.start(250);
  // Level meter + voice activity: RMS of the waveform, every 50 ms (timers keep running when rAF doesn't).
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  const maxMs = (status?.stt.maxSeconds ?? 300) * 1000;
  let noise = 0.01;
  let samples = 0;
  let loudFor = 0;
  let quietSince = 0;
  const timer = setInterval(() => {
    if (!rec || my !== token) return;
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const rms = Math.sqrt(sum / buf.length);
    // the first half second is mostly room noise: learn the floor from it
    if (samples < 10) noise = samples ? (noise * samples + rms) / (samples + 1) : rms;
    samples++;
    const threshold = Math.max(0.012, noise * 2.5);
    const now = Date.now();
    if (rms > threshold) {
      loudFor += 50;
      quietSince = 0;
      if (loudFor >= 200) rec.heard = true;
    } else {
      loudFor = 0;
      quietSince ||= now;
    }
    rec.level = Math.min(1, rms * 6);
    emit();
    if (now - rec.startedAt > maxMs) {
      store.toast(`stopped at the ${Math.round(maxMs / 1000)} s limit`);
      void stopDictation();
    } else if (rec.mode === "vad") {
      if (rec.heard && quietSince && now - quietSince > SILENCE_MS) void stopDictation();
      else if (!rec.heard && now - rec.startedAt > NO_SPEECH_MS) {
        cancelDictation();
        store.toast("didn't hear anything — stopped listening (click the mic to talk)");
      }
    }
  }, 50);
  live = { stream, recorder, chunks, ctx, timer, mime: recorder.mimeType || mime || "audio/webm", stopped };
  rec = { ...rec!, phase: "recording", startedAt: Date.now() };
  emit();
  if (stopWhenReady) void stopDictation();
}

function release() {
  const l = live;
  live = undefined;
  if (!l) return;
  clearInterval(l.timer);
  l.stream.getTracks().forEach((t) => t.stop());
  void l.ctx.close().catch(() => {});
}

/** Stop without transcribing (Esc). */
export function cancelDictation() {
  token++;
  if (live?.recorder.state === "recording") live.recorder.stop();
  release();
  rec = null;
  stopWhenReady = false;
  emit();
}

function blobBase64(b: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(b);
  });
}

/** Stop recording, transcribe, insert at the cursor (and send, if set). */
export async function stopDictation() {
  if (!rec) return;
  if (rec.phase === "starting") {
    stopWhenReady = true;
    return;
  }
  if (rec.phase !== "recording" || !live) return;
  const my = token;
  const l = live;
  const { target, startedAt, heard, mode } = rec;
  // Releasing Space then Shift calls this twice; mark it finished now so the second call is a no-op.
  rec = { ...rec, phase: "transcribing", level: 0 };
  emit();
  if (l.recorder.state === "recording") l.recorder.stop();
  await l.stopped;
  release();
  const seconds = (Date.now() - startedAt) / 1000;
  const blob = new Blob(l.chunks, { type: l.mime });
  if (my !== token) return;
  if (seconds < 0.4 || blob.size < 200 || (mode === "vad" && !heard)) {
    rec = null;
    emit();
    if (mode !== "vad") store.toast("too short — hold the key (or keep the mic on) while you talk");
    return;
  }
  rec = { ...rec, phase: "transcribing", level: 0 };
  emit();
  try {
    const audio = await blobBase64(blob);
    const r = await rpc("transcribe", { audio, mime: l.mime, seconds, agent: target === BROADCAST ? undefined : target });
    if (my !== token) return;
    const text = r.text.trim();
    if (!text) store.toast("heard nothing to type");
    else deliver(target, text);
  } catch (e: any) {
    if (my === token) store.toast(`dictation: ${e?.message ?? e}`, "error");
  } finally {
    if (my === token) {
      rec = null;
      emit();
    }
  }
}

// ---- spoken replies ----

let actx: AudioContext | undefined;
/** Create/resume the audio output during a click or key press (browsers block sound before one). */
export function unlockAudio() {
  try {
    actx ??= new AudioContext();
    if (actx.state === "suspended") void actx.resume();
  } catch {}
}
const queue: { agent: string; audio: string }[] = [];
let playing: { agent: string; src: AudioBufferSourceNode } | null = null;
export const speakingAgent = () => playing?.agent ?? (queue.length ? queue[0].agent : undefined);

async function playNext() {
  if (playing || !queue.length) return;
  const item = queue.shift()!;
  unlockAudio();
  if (!actx) return;
  try {
    const bytes = Uint8Array.from(atob(item.audio), (c) => c.charCodeAt(0));
    const buf = await actx.decodeAudioData(bytes.buffer);
    const src = actx.createBufferSource();
    src.buffer = buf;
    src.connect(actx.destination);
    playing = { agent: item.agent, src };
    emit();
    src.onended = () => {
      const was = playing;
      if (playing?.src === src) playing = null;
      emit();
      if (was?.src === src) afterSpeech(item.agent);
      void playNext();
    };
    src.start();
  } catch (e: any) {
    store.toast(`couldn't play the spoken reply: ${e?.message ?? e}`, "error");
    playing = null;
    emit();
    void playNext();
  }
}

/** Stop spoken replies (all, or one agent's). */
export function stopSpeech(agent?: string) {
  for (let i = queue.length - 1; i >= 0; i--) if (!agent || queue[i].agent === agent) queue.splice(i, 1);
  if (playing && (!agent || playing.agent === agent)) {
    const p = playing;
    playing = null;
    try {
      p.src.onended = null;
      p.src.stop();
    } catch {}
    void playNext();
  }
  emit();
}

/** Conversation mode, hands-free: listen again once the reply has been spoken. */
function afterSpeech(agent: string) {
  const v = paneVoice(agent);
  if (!v.talk || voiceSettings().handsFree === false) return;
  if (queue.some((q) => q.agent === agent) || rec) return;
  if (!store.layout.panes.some((p) => p.name === agent) || !store.agents.has(agent)) return;
  if (document.visibilityState !== "visible" || overlays.top) return;
  setTimeout(() => {
    if (!rec && !playing && paneVoice(agent).talk) void startDictation(agent, "vad");
  }, 250);
}

const AUTO_PROMPT = /^(You have \d+ unread hive messages?|\[hive job #|\[follow-up from )/;

/** A turn ended: speak a short summary if this pane wants it. */
async function maybeSpeak(name: string, stopReason: string) {
  if (stopReason !== "end_turn") return;
  const v = paneVoice(name);
  if (!v.speak && !v.talk) return;
  const st = await loadVoiceStatus();
  if (!st?.tts) return;
  const items = store.pane(name).items;
  let u = items.length - 1;
  while (u >= 0 && items[u].k !== "user") u--;
  const prompt = u >= 0 ? (items[u] as { text: string }).text : "";
  // Turns hive started (jobs, mail) only when you're looking at that pane, and only if allowed.
  if (AUTO_PROMPT.test(prompt) && !(voiceSettings().speakAuto !== false && document.hasFocus() && focus.active === name)) return;
  let reply = "";
  for (let i = items.length - 1; i > u; i--)
    if (items[i].k === "agent") {
      reply = (items[i] as { text: string }).text;
      break;
    }
  if (!reply.trim()) return afterSpeech(name);
  try {
    const r = await rpc("speak", { agent: name, text: reply.slice(0, 20_000), voice: v.id });
    if (!r.audio) return afterSpeech(name);
    queue.push({ agent: name, audio: r.audio });
    emit();
    void playNext();
  } catch (e: any) {
    store.toast(`spoken reply: ${e?.message ?? e}`, "error");
  }
}

/** Conversation mode on/off for a pane. */
export function toggleTalk(name: string, on = !paneVoice(name).talk) {
  setPaneVoice(name, { talk: on });
  if (on) {
    unlockAudio();
    void loadVoiceStatus().then((st) => {
      if (st && !st.tts) store.toast("conversation mode: replies won't be spoken until ELEVENLABS_API_KEY is set", "error");
    });
    focus.to(name);
    store.toast(`talking with ${name} — speak, then pause; Esc stops`);
    void startDictation(name, voiceSettings().handsFree === false ? "toggle" : "vad");
  } else {
    stopSpeech(name);
    if (rec?.target === name) cancelDictation();
  }
}

// ---- keys: push-to-talk, Esc ----

function isPtt(e: KeyboardEvent): boolean {
  const k = pttKey();
  if (k === "off") return false;
  if (k === "f9") return e.code === "F9" && !e.ctrlKey && !e.altKey && !e.metaKey;
  if (e.code !== "Space") return false;
  if (k === "ctrl+shift+space") return (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey;
  if (k === "ctrl+space") return (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey;
  return e.altKey && e.shiftKey && !e.ctrlKey;
}

function keyTarget(): string | undefined {
  const a = document.activeElement;
  if (a?.closest(".broadcast")) return BROADCAST;
  const pane = (a?.closest("[data-pane]") as HTMLElement | null)?.dataset.pane;
  const name = pane ?? focus.active ?? store.layout.panes[0]?.name;
  return name && targets.has(name) ? name : targets.has(BROADCAST) && !store.layout.panes.length ? BROADCAST : name;
}

let pressAt = 0;
let installed = false;
/** Install the push-to-talk and Esc handlers and the speak-on-turn-end hook (once). */
export function installVoice() {
  if (installed) return;
  installed = true;
  onTurnEnd((name, stop) => void maybeSpeak(name, stop));
  window.addEventListener(
    "keydown",
    (e) => {
      if (isPtt(e)) {
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat || overlays.top) return;
        if (rec && (rec.mode !== "hold" || rec.phase === "recording")) {
          void stopDictation();
          return;
        }
        const t = keyTarget();
        if (!t) return;
        pressAt = Date.now();
        void startDictation(t, "hold");
        return;
      }
      if (e.key === "Escape" && !overlays.top) {
        if (rec && rec.phase !== "transcribing") {
          e.preventDefault();
          e.stopPropagation();
          const talk = rec.target !== BROADCAST && paneVoice(rec.target).talk;
          cancelDictation();
          if (talk) store.toast("stopped listening — click the mic or press the talk key to go on");
        } else if (speakingAgent()) {
          e.preventDefault();
          e.stopPropagation();
          stopSpeech();
        }
      }
    },
    true,
  );
  window.addEventListener(
    "keyup",
    (e) => {
      if (!rec || rec.mode !== "hold") return;
      const k = pttKey();
      const released = k === "f9" ? e.code === "F9" : e.code === "Space" || e.key === "Control" || e.key === "Meta" || e.key === "Shift" || e.key === "Alt";
      if (!released) return;
      if (Date.now() - pressAt < 350) {
        // a tap: keep listening until the next press (or a click on the mic)
        rec.mode = "toggle";
        stopWhenReady = false;
        emit();
      } else void stopDictation();
    },
    true,
  );
  // An agent's mic shouldn't stay open in a hidden tab (phone locked, window switched away in the browser).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && rec?.mode === "vad") cancelDictation();
  });
  void loadVoiceStatus();
}

// ---- components ----

const IconMic = ({ size = 16 }: { size?: number }) => (
  <svg className="icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="5.5" y="1.5" width="5" height="8" rx="2.5" />
    <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5V15" />
  </svg>
);
const IconSpeaker = ({ size = 16, on }: { size?: number; on?: boolean }) => (
  <svg className="icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M2 6v4h3l4 3V3L5 6H2Z" />
    {on ? <path d="M11.5 5.5a3.5 3.5 0 0 1 0 5M13 3.5a6 6 0 0 1 0 9" /> : <path d="M11.5 6l3 4M14.5 6l-3 4" />}
  </svg>
);

/** Mic button (+ level meter and timer while recording) for one dictation target. */
export function MicButton({ target, disabled }: { target: string; disabled?: boolean }) {
  const r = useVoice(() => (rec?.target === target ? { ...rec } : null));
  const st = useVoice(() => status);
  const [, tick] = useState(0);
  useEffect(() => {
    if (r?.phase !== "recording") return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [r?.phase]);
  const ready = !!st?.stt.provider;
  const secs = r ? Math.floor((Date.now() - r.startedAt) / 1000) : 0;
  const title = !st
    ? "dictate"
    : !ready
      ? "dictation isn't set up — click for how"
      : r?.phase === "recording"
        ? `listening${r.mode === "vad" ? " (stops when you pause)" : ""} — click to stop and type it, Esc to cancel`
        : r?.phase === "transcribing"
          ? "turning speech into text…"
          : `dictate (click, or hold ${pttLabel()}) · ${st.stt.provider}`;
  return (
    <span className={`mic${r ? " " + r.phase : ""}${st && !ready ? " unset" : ""}`}>
      {r?.phase === "recording" && (
        <span className="mic-live" aria-live="off">
          <span className="mic-level" style={{ ["--lvl" as any]: r.level.toFixed(2) } as React.CSSProperties} />
          <span className="mic-time">{Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}</span>
        </span>
      )}
      <button
        type="button"
        className="ghost mic-btn"
        disabled={disabled || r?.phase === "transcribing"}
        onMouseDown={(e) => e.preventDefault() /* keep the cursor where it is in the text box */}
        onClick={() => {
          if (!ready && st) return openSetup();
          if (r) return r.phase === "starting" ? cancelDictation() : void stopDictation();
          const talk = target !== BROADCAST && paneVoice(target).talk && voiceSettings().handsFree !== false;
          void startDictation(target, talk ? "vad" : "toggle");
        }}
        title={title}
        aria-label={r?.phase === "recording" ? "stop dictation" : "dictate"}
        aria-pressed={r?.phase === "recording"}
      >
        {r?.phase === "transcribing" ? <span className="mic-spin" aria-hidden /> : <IconMic />}
      </button>
    </span>
  );
}

/** Pane header: conversation/speaking indicator and the voice menu. */
export function PaneVoiceControls({ name }: { name: string }) {
  const v = useStore(() => paneVoice(name));
  const speaking = useVoice(() => playing?.agent === name);
  const listening = useVoice(() => rec?.target === name && rec.phase === "recording");
  const open = useVoice(() => menuFor === name);
  return (
    <span className="voice-ctl">
      {v.talk && (
        <span className={`voice-badge talking${listening ? " listening" : ""}${speaking ? " speaking" : ""}`} title="conversation mode: dictation sends at once and replies are spoken (palette: Talk with …)">
          <IconMic size={12} /> {listening ? "listening" : speaking ? "speaking" : "talk"}
        </span>
      )}
      {!v.talk && speaking && (
        <span className="voice-badge speaking" title="speaking the reply — Esc or click the pane to stop">
          <IconSpeaker size={12} on /> speaking
        </span>
      )}
      <button
        className={v.speak || v.talk ? "on" : ""}
        onClick={() => openVoiceMenu(open ? null : name)}
        title={`voice for ${name}: speak replies, conversation mode, which voice`}
        aria-label="voice settings"
        aria-expanded={open}
      >
        <IconSpeaker on={!!(v.speak || v.talk)} />
      </button>
      {open && <VoiceMenu name={name} onClose={() => openVoiceMenu(null)} />}
    </span>
  );
}

let menuFor: string | null = null;
export function openVoiceMenu(name: string | null) {
  menuFor = name;
  emit();
}

let voiceCache: { id: string; name: string; labels?: string }[] | null = null;

function VoiceMenu({ name, onClose }: { name: string; onClose: () => void }) {
  const v = useStore(() => paneVoice(name));
  const st = useVoice(() => status);
  const [voices, setVoices] = useState(voiceCache);
  const [err, setErr] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useOverlay("modal", onClose);
  useEffect(() => {
    void loadVoiceStatus(true).then((s) => {
      if (s?.tts && !voiceCache)
        rpc("voiceList", {})
          .then((l) => {
            voiceCache = l;
            setVoices(l);
          })
          .catch((e) => setErr(e.message));
    });
    const away = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest?.(".voice-ctl")) onClose();
    };
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, []);
  return (
    <div className="voice-menu" ref={ref} role="dialog" aria-label={`voice for ${name}`} onDoubleClick={(e) => e.stopPropagation()}>
      <div className="vm-title">Voice for {name}</div>
      <label className="vm-row">
        <input type="checkbox" checked={!!v.speak} onChange={(e) => (unlockAudio(), setPaneVoice(name, { speak: e.target.checked }))} />
        Speak replies <span className="dim small">a short summary, not the whole reply</span>
      </label>
      <label className="vm-row">
        <input type="checkbox" checked={!!v.talk} onChange={(e) => toggleTalk(name, e.target.checked)} />
        Conversation mode <span className="dim small">sends what you say, speaks replies{voiceSettings().handsFree === false ? "" : ", listens again"}</span>
      </label>
      {st && !st.tts ? (
        <div className="small warn">Spoken replies need ELEVENLABS_API_KEY. <a href={VOICE_DOCS} target="_blank" rel="noreferrer">How to set it up</a></div>
      ) : (
        <label className="vm-row col">
          <span className="small dim">Voice</span>
          <select
            value={v.id ?? ""}
            onChange={(e) => setPaneVoice(name, { id: e.target.value || undefined, name: voices?.find((x) => x.id === e.target.value)?.name })}
          >
            <option value="">Default voice{v.id && !voices ? ` (${v.name ?? v.id})` : ""}</option>
            {v.id && !voices && <option value={v.id}>{v.name ?? v.id}</option>}
            {voices?.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
                {x.labels ? ` — ${x.labels}` : ""}
              </option>
            ))}
          </select>
          {err && <span className="small err">{err}</span>}
        </label>
      )}
      <div className="vm-row">
        <button
          className="small"
          disabled={!st?.tts}
          onClick={() => {
            unlockAudio();
            rpc("speak", { agent: name, text: `Hi, this is ${name}. This is how my replies will sound.`, voice: v.id })
              .then((r) => {
                if (r.audio) {
                  queue.push({ agent: name, audio: r.audio });
                  void playNext();
                }
              })
              .catch((e) => store.toast(e.message, "error"));
          }}
        >
          Preview
        </button>
        <span className="spacer" />
        <span className="dim small">dictate: {pttLabel()}</span>
      </div>
    </div>
  );
}

// ---- setup help (no provider configured) ----

let setupOpen = false;
export function openSetup() {
  setupOpen = true;
  void loadVoiceStatus(true);
  emit();
}

/** Mounted once (App): the "Dictation: set up" dialog. */
export function VoiceLayer() {
  const open = useVoice(() => setupOpen);
  if (!open) return null;
  return (
    <VoiceSetup
      onClose={() => {
        setupOpen = false;
        emit();
      }}
    />
  );
}

function VoiceSetup({ onClose }: { onClose: () => void }) {
  useOverlay("modal", onClose);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal voice-setup" role="dialog" aria-label="dictation setup">
        <h2>Voice: dictation and spoken replies</h2>
        <VoiceStatusRows />
        <SttPicker />
        <p className="small dim">
          Dictate with the mic button or hold {pttLabel()} (tap it to keep listening). Audio goes only to the provider you pick. Handy still works: it types into the pane you hover.
        </p>
        <div className="row1">
          <span className="spacer" />
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

/** Choose the dictation provider, model and language (keys stay in hive's environment). */
function SttPicker() {
  const st = useVoice(() => status);
  const [provider, setProvider] = useState<string>("auto");
  const [model, setModel] = useState("");
  const [language, setLanguage] = useState("");
  const [saved, setSaved] = useState("");
  useEffect(() => {
    if (!st) return;
    setProvider(st.stt.wanted || "auto");
    setModel(st.stt.wanted !== "auto" ? (st.stt.model ?? "") : "");
    setLanguage(st.stt.language ?? "");
  }, [!!st]);
  if (!st) return null;
  const info = st.stt.providers.find((p) => p.id === provider);
  const save = () =>
    rpc("setStt", { provider, model, language })
      .then((s) => {
        status = s;
        emit();
        setSaved(s.stt.provider ? `saved: dictation uses ${s.stt.providers.find((p) => p.id === s.stt.provider)?.label}` : `saved, but ${s.stt.problem}`);
      })
      .catch((e) => setSaved(e.message));
  return (
    <div className="stt-picker">
      <h3>Dictation provider</h3>
      <label className="stt-row">
        <input type="radio" name="stt" checked={provider === "auto"} onChange={() => setProvider("auto")} />
        <span className="stt-name">Automatic</span>
        <span className="dim small">the first one that is set up</span>
      </label>
      {st.stt.providers.map((p) => (
        <label key={p.id} className={`stt-row${st.stt.configured[p.id] ? " ok" : ""}`}>
          <input type="radio" name="stt" checked={provider === p.id} onChange={() => (setProvider(p.id), setModel(""))} />
          <span className="stt-name">{p.label}</span>
          <span className={`small ${st.stt.configured[p.id] ? "stt-ready" : "dim"}`}>{st.stt.configured[p.id] ? "✓ ready" : `needs ${p.needs}`}</span>
          <span className="dim small stt-note">{p.note}</span>
        </label>
      ))}
      <div className="stt-fields">
        <label>
          Model <span className="dim small">(empty = provider default)</span>
          <input list="stt-models" value={model} onChange={(e) => setModel(e.target.value)} placeholder={info?.models[0] ?? "server default"} />
          <datalist id="stt-models">
            {(info?.models ?? []).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
        <label>
          Language <span className="dim small">(e.g. en, fi; empty = detect)</span>
          <input value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="auto" />
        </label>
      </div>
      <div className="row1">
        <span className="dim small">{saved || "Keys are read from hive's environment (set them, then restart hive). The choice is saved per project."}</span>
        <span className="spacer" />
        <button className="primary" onClick={() => void save()}>
          Save
        </button>
      </div>
    </div>
  );
}

/** Provider status rows (setup dialog and the Accounts tab). */
export function VoiceStatusRows() {
  const st = useVoice(() => status);
  useEffect(() => void loadVoiceStatus(true), []);
  if (!st) return <div className="dim small">checking voice providers…</div>;
  const sttOk = !!st.stt.provider;
  return (
    <>
      <div className={`acct ${sttOk ? "ok" : "no"}`}>
        <span className="acct-mark" aria-label={sttOk ? "ready" : "not set up"}>{sttOk ? "✓" : "✗"}</span>
        <div className="acct-main">
          <div className="row1">
            <strong>Dictation (speech to text)</strong>
            <span className="kind">{st.stt.provider ? `stt:${st.stt.provider}` : `HIVE_STT=${st.stt.wanted}`}</span>
            <span className="dim small">
              {sttOk ? `${st.stt.endpoint ?? ""}${st.stt.model ? ` · model ${st.stt.model}` : ""} · up to ${st.stt.maxSeconds}s` : st.stt.problem}
            </span>
          </div>
          <div className="small dim">
            configured: {st.stt.providers.map((p) => `${p.id} ${st.stt.configured[p.id] ? "✓" : "—"}`).join(" · ")}
          </div>
        </div>
      </div>
      <div className={`acct ${st.tts ? "ok" : "no"}`}>
        <span className="acct-mark" aria-label={st.tts ? "ready" : "not set up"}>{st.tts ? "✓" : "✗"}</span>
        <div className="acct-main">
          <div className="row1">
            <strong>Spoken replies (ElevenLabs)</strong>
            <span className="kind">tts</span>
            <span className="dim small">{st.tts ? "ELEVENLABS_API_KEY set" : "set ELEVENLABS_API_KEY to hear replies"}</span>
          </div>
        </div>
      </div>
    </>
  );
}

/** Accounts tab section. */
export function VoiceAccounts() {
  return (
    <section className="voice-accounts">
      <h3>
        Voice <a className="small" href={VOICE_DOCS} target="_blank" rel="noreferrer">set up</a>
      </h3>
      <VoiceStatusRows />
    </section>
  );
}

// ---- palette ----

const PTT_ORDER: NonNullable<VoiceSettings["pttKey"]>[] = ["ctrl+shift+space", "ctrl+space", "alt+shift+space", "f9", "off"];

/** Palette entries: per-agent voice/talk, dictation setup and settings. */
export function voiceActions(names: string[]): PaletteAction[] {
  const s = voiceSettings();
  const next = PTT_ORDER[(PTT_ORDER.indexOf(pttKey()) + 1) % PTT_ORDER.length];
  return [
    ...names.flatMap((n) => {
      const v = paneVoice(n);
      return [
        { id: "talk-" + n, label: `${v.talk ? "Stop talking with" : "Talk with"} ${n}`, hint: "conversation mode: speak, it answers out loud", run: () => toggleTalk(n) },
        { id: "voice-" + n, label: `Voice for ${n}…`, hint: v.name ?? (v.id ? v.id : "default voice"), run: () => setTimeout(() => openVoiceMenu(n), 0) },
        { id: "speak-" + n, label: `Speak replies from ${n}: ${v.speak ? "turn off" : "turn on"}`, run: () => (unlockAudio(), setPaneVoice(n, { speak: !v.speak })) },
      ];
    }),
    { id: "voice-setup", label: `Dictation: ${status?.stt.provider ? `set up (${status.stt.provider})` : "set up"}`, hint: "speech-to-text provider, keys, local Whisper", run: () => setTimeout(openSetup, 0) },
    { id: "voice-send", label: `Send after dictation: ${s.sendAfter ? "turn off" : "turn on"}`, hint: "otherwise the text waits in the box for you", run: () => setVoiceSettings({ sendAfter: !s.sendAfter }) },
    {
      id: "voice-ptt",
      label: `Push-to-talk key: ${pttLabel()} → ${PTT_LABEL[next]}`,
      hint: "hold to talk, tap to keep listening; Handy uses Ctrl+Space by default",
      keys: pttKey() === "off" ? undefined : pttLabel(),
      run: () => setVoiceSettings({ pttKey: next }),
    },
    { id: "voice-hands", label: `Hands-free conversation: ${s.handsFree === false ? "turn on" : "turn off"}`, hint: "listen again after a spoken reply, until you pause", run: () => setVoiceSettings({ handsFree: s.handsFree === false }) },
    { id: "voice-auto", label: `Speak job/mail turns of the focused pane: ${s.speakAuto === false ? "turn on" : "turn off"}`, run: () => setVoiceSettings({ speakAuto: s.speakAuto === false }) },
    ...(speakingAgent() ? [{ id: "voice-stop", label: "Stop speaking", keys: "Esc", run: () => stopSpeech() }] : []),
  ];
}
