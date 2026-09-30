/**
 * UI backend over its NDJSON stdio protocol (what Electron main relays):
 * add a pane agent, prompt it, answer a permission ask and an elicitation from
 * "the UI", schedule a job, persist layout, read history.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nodeEntry } from "../src/core/paths.js";
import type { BackendEvent } from "../src/ui/protocol.js";
import { assert, finish, freshDir, until } from "./util.js";

const dir = freshDir(".hive-test-backend");
const be = nodeEntry("ui/backend");
const proc = spawn(be.command, [...be.args, "--db", join(dir, "hive.db"), "--cwd", dir, "--poll", "200"], {
  stdio: ["pipe", "pipe", "inherit"],
});
const events: BackendEvent[] = [];
const waiting = new Map<number, (m: any) => void>();
createInterface({ input: proc.stdout! }).on("line", (line) => {
  const m = JSON.parse(line);
  if (typeof m.id === "number") waiting.get(m.id)?.(m);
  else events.push(m);
});
let id = 0;
function call(method: string, params: unknown): Promise<any> {
  const i = ++id;
  return new Promise((res, rej) => {
    waiting.set(i, (m) => (m.error ? rej(new Error(m.error)) : res(m.result)));
    proc.stdin!.write(JSON.stringify({ id: i, method, params }) + "\n");
  });
}
const text = (agent: string) =>
  events
    .filter((e) => e.event === "agent" && e.agent === agent && (e.e as any).type === "text")
    .map((e: any) => e.e.text)
    .join("");

await until(() => events.some((e) => e.event === "ready"), 20_000, "ready");
const ready = events.find((e) => e.event === "ready") as Extract<BackendEvent, { event: "ready" }>;
assert(ready.kinds.some((k) => k.id === "claude") && ready.layout.columns === 2, "ready event lists agent kinds and default layout");

const view = await call("addAgent", { name: "pane1", kind: "mock", cwd: dir, policy: "ask" });
assert(view.name === "pane1" && view.config[0]?.id === "model", "addAgent returns an AgentView with config options");

await call("prompt", { name: "pane1", text: "please edit something" });
await until(() => events.some((e) => e.event === "permission"), 10_000, "permission ask");
const ask = (events.find((e) => e.event === "permission") as any).ask;
assert(ask.agent === "pane1" && ask.options.length === 2, "permission ask forwarded to the UI with options");
await call("answerPermission", { reqId: ask.reqId, optionId: "allow" });
await until(() => text("pane1").includes("edit allowed"), 10_000, "edit allowed");
assert(events.some((e) => e.event === "permission_done"), "UI answer resolved the agent's permission request");

await call("prompt", { name: "pane1", text: "ask? now" });
await until(() => events.some((e) => e.event === "elicitation"), 10_000, "elicitation");
const el = (events.find((e) => e.event === "elicitation") as any).ask;
assert(el.fields[0]?.key === "answer" && el.fields[0].required, "elicitation form fields forwarded");
await call("answerElicitation", { reqId: el.reqId, action: "accept", content: { answer: "blue" } });
await until(() => text("pane1").includes('elicit: accept {"answer":"blue"}'), 10_000, "elicit answer");
assert(true, "elicitation answered from the UI");

await until(() => events.some((e) => e.event === "agents" && e.agents.some((a) => a.name === "pane1" && a.ctx)), 5000, "agents push");
const av = [...events].reverse().find((e) => e.event === "agents") as any;
assert(av.agents[0].ctx.size === 200_000 && av.agents[0].auth === "Mock login", "agents push carries ctx and auth");

await call("setConfig", { name: "pane1", configId: "model", value: "mock-large" });
await until(
  () => events.some((e) => e.event === "agents" && e.agents.some((a) => a.config[0]?.currentValue === "mock-large")),
  5000,
  "config push",
);
assert(true, "setConfig reflected in agent view");

const jobId = await call("addJob", { agent: "pane1", kind: "loop", prompt: "loop it", times: 2 });
await until(() => events.some((e) => e.event === "job" && e.text.includes(`job ${jobId} ended: done`)), 20_000, "job done");
assert(events.filter((e) => e.event === "job" && e.text.startsWith(`■ job ${jobId}`)).length === 2, "UI job ran twice on the pane agent");

const hist = await call("history", { name: "pane1" });
assert(hist.some((h: any) => h.type === "prompt") && hist.some((h: any) => h.type === "reply" && /done/.test(h.data.text)), "history returns prompts and replies");

await call("saveLayout", { panes: [{ name: "pane1", kind: "mock", cwd: dir }], columns: 3, hoverFocus: false, sidebar: true });
const saved = JSON.parse(readFileSync(join(dir, "ui.json"), "utf8"));
assert(saved.columns === 3 && saved.panes[0].name === "pane1", "layout persisted to .hive/ui.json");

let bad = "";
await call("addAgent", { name: "bad name!", kind: "mock", cwd: dir }).catch((e) => (bad = e.message));
assert(/name must be/.test(bad), "invalid pane names rejected");
await call("addAgent", { name: "x", kind: "mock", cwd: join(dir, "nope") }).catch((e) => (bad = e.message));
assert(/does not exist/.test(bad), "missing folder rejected");

await call("removeAgent", { name: "pane1" });
proc.stdin!.end();
await new Promise((r) => proc.on("exit", r));
assert(existsSync(join(dir, "hive.db")), "backend shut down cleanly on stdin close");
finish("backend");
