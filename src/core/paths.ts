/**
 * Where hive's own entry points live, in dev (tsx, src/) and prod (node, dist/).
 * Kept in one place so the agent registry, the session and the CLI agree.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
/** True when running from src/ through tsx rather than from dist/. */
export const isTs = here.endsWith("src/core") || here.endsWith("src\\core");

const ext = isTs ? ".ts" : ".js";

/** Absolute path to a hive module, e.g. entry("hive/server") → src/hive/server.ts. */
export function entry(rel: string): string {
  return join(here, "..", rel + ext);
}

/** Path to the tsx CLI so hive subprocesses can run from source in dev. */
export function tsxCli(): string {
  return fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));
}

/** command + args to run a hive entry point with the current node binary. */
export function nodeEntry(rel: string): { command: string; args: string[] } {
  return { command: process.execPath, args: isTs ? [tsxCli(), entry(rel)] : [entry(rel)] };
}
