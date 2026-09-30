import { rmSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { AGENTS, type AgentDef } from "../src/core/agents.js";

let failed = false;

export function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error(`❌ ${msg}`);
    failed = true;
    process.exitCode = 1;
  } else console.log(`✅ ${msg}`);
}

export function freshDir(name: string): string {
  const dir = resolve(name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function mock(name: string, env: Record<string, string> = {}): AgentDef {
  return { ...AGENTS.mock, env: { ...(AGENTS.mock.env ?? {}), MOCK_NAME: name, ...env } };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until(cond: () => boolean, timeoutMs: number, what: string) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(50);
  }
}

export function finish(label: string) {
  console.log(failed ? `\n${label}: FAILED` : `\n${label}: ALL PASSED`);
  process.exit(failed ? 1 : 0);
}
