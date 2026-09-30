/**
 * `hive doctor`: is each agent installed, does it speak ACP, is it logged in?
 * Spawns the adapter, sends `initialize` only (no session, no tokens spent),
 * reports what it advertises, and kills it.
 */
import { spawn, spawnSync } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type * as schema from "@agentclientprotocol/sdk";
import { resolveEnv, spawnSpec, type AgentDef } from "./agents.js";

export interface ProbeResult {
  id: string;
  installed: "ok" | "missing" | "npx";
  ok: boolean;
  ms?: number;
  protocolVersion?: number;
  agent?: string;
  auth?: string;
  features?: string[];
  error?: string;
  stderr?: string;
}

/** Cheap PATH check; npx-launched adapters are fetched on demand. */
export function installed(def: AgentDef): ProbeResult["installed"] {
  if (/^npx(\.cmd)?$/.test(def.command)) return "npx";
  if (/[\\/]/.test(def.command)) return "ok"; // absolute path (e.g. node for the mock)
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [def.command]);
  return r.status === 0 ? "ok" : "missing";
}

/**
 * claude-agent-acp and codex-acp advertise an empty `_meta.authStatus` marker
 * in `initialize` and then *push* the identity as `_auth/status_update`
 * `{authStatus: {kind, label, detail?}}` (kind "none" = logged out). Silence
 * means the agent couldn't tell.
 */
export const AUTH_STATUS_UPDATE = "_auth/status_update";
export interface AuthStatus {
  kind: string;
  label?: string;
  detail?: string;
}
export function authLabel(a: AuthStatus): string {
  return [a.label ?? a.kind, a.detail].filter(Boolean).join(" · ");
}

export async function probe(def: AgentDef, timeoutMs = 90_000, authWaitMs = 8000): Promise<ProbeResult> {
  const res: ProbeResult = { id: def.id, installed: installed(def), ok: false };
  if (res.installed === "missing") return { ...res, error: `"${def.command}" not on PATH. ${def.install}` };
  const spec = spawnSpec(def);
  const t0 = Date.now();
  const proc = spawn(spec.command, spec.args, {
    env: { ...process.env, ...resolveEnv(def) },
    stdio: ["pipe", "pipe", "pipe"],
    shell: spec.shell,
    windowsHide: true,
  });
  let stderr = "";
  proc.stderr?.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
  const died = new Promise<never>((_, rej) => {
    proc.on("error", (e) => rej(e));
    proc.on("exit", (code) => rej(new Error(`exited with code ${code} before answering initialize`)));
  });
  const stream = acp.ndJsonStream(
    Writable.toWeb(proc.stdin!),
    Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>,
  );
  let timer: NodeJS.Timeout | undefined;
  let pushed: AuthStatus | undefined;
  let gotAuth: () => void = () => {};
  const authArrived = new Promise<void>((r) => (gotAuth = r));
  try {
    const init = await Promise.race([
      acp
        .client({ name: "hive-doctor" })
        .onNotification(AUTH_STATUS_UPDATE, (p: unknown) => p as { authStatus?: AuthStatus }, (ctx) => {
          pushed = ctx.params.authStatus;
          gotAuth();
        })
        .connectWith(stream, async (ctx) => {
          const init = await ctx.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
          });
          // The first push follows initialize asynchronously (a CLI probe).
          if ((init.agentCapabilities?._meta as any)?.authStatus !== undefined)
            await Promise.race([authArrived, new Promise((r) => setTimeout(r, authWaitMs))]);
          return init;
        }),
      died,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`no initialize response after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
    Object.assign(res, summarize(init));
    if (pushed) res.auth = pushed.kind === "none" ? "not logged in" : authLabel(pushed);
    res.ok = true;
  } catch (e: any) {
    res.error = String(e?.message ?? e);
    res.stderr = stderr.trim().split("\n").slice(-5).join("\n");
  } finally {
    clearTimeout(timer);
    res.ms = Date.now() - t0;
    proc.kill();
  }
  return res;
}

export function summarize(init: schema.InitializeResponse): Partial<ProbeResult> {
  const caps = init.agentCapabilities ?? {};
  const sc = caps.sessionCapabilities ?? {};
  const meta = (caps._meta ?? {}) as Record<string, any>;
  const features = [
    caps.loadSession && "load",
    sc.resume && "resume",
    sc.fork && "fork",
    sc.list && "list",
    sc.close && "close",
    (sc as any).subagents && "subagents",
    caps.promptCapabilities?.image && "image",
    caps.mcpCapabilities?.http && "mcp-http",
    meta.claudeCode?.promptQueueing && "queueing",
  ].filter(Boolean) as string[];
  let auth = "unknown";
  const s = meta.authStatus ?? (init._meta as any)?.authStatus;
  if (typeof s === "string") auth = s;
  else if (s && typeof s === "object" && Object.keys(s).length) auth = s.kind ? authLabel(s) : JSON.stringify(s);
  else if (s) auth = "not reported";
  else if (init.authMethods?.length) auth = `unknown (methods: ${init.authMethods.map((m) => m.name ?? m.id).join(", ")})`;
  return {
    protocolVersion: init.protocolVersion,
    agent: init.agentInfo ? `${init.agentInfo.name} ${init.agentInfo.version ?? ""}`.trim() : undefined,
    auth,
    features,
  };
}
