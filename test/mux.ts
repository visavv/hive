/** Mux: one backend, many clients; ids routed back, events broadcast, ready replayed, restart on crash. */
import { writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { assert, finish, freshDir, sleep, until } from "./util.js";

const dir = freshDir(".hive-test-mux");
process.env.HIVE_HOME = join(dir, "home");
execFileSync("git", ["init", "-q"], { cwd: dir });
const { runMux, isLive } = await import("../src/ui/mux.js");

// a stand-in backend: "ready" on start, echoes requests, "boom" crashes it, "tick" broadcasts an event
const fake = join(dir, "fake-backend.mjs");
writeFileSync(
  fake,
  `import { createInterface } from "node:readline";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
send({ event: "ready", pid: process.pid });
createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.method === "boom") process.exit(1);
  if (m.method === "tick") send({ event: "tick", n: m.params.n });
  send({ id: m.id, result: { echo: m.params, method: m.method } });
});
process.stdin.on("end", () => process.exit(0));`,
);

const mux = await runMux({ cwd: dir, backend: { command: process.execPath, args: [fake] } });
assert(await isLive(mux.path), "mux listens on the project's local socket");

function client(): Promise<{ sock: Socket; lines: any[]; req: (id: number, method: string, params?: unknown) => void }> {
  return new Promise((res) => {
    const sock = createConnection(mux.path);
    const lines: any[] = [];
    createInterface({ input: sock }).on("line", (l) => lines.push(JSON.parse(l)));
    sock.once("connect", () => res({ sock, lines, req: (id, method, params = {}) => sock.write(JSON.stringify({ id, method, params }) + "\n") }));
  });
}

const a = await client();
await until(() => a.lines.some((l) => l.event === "ready"), 5000, "mux event");
const b = await client();
await until(() => b.lines.some((l) => l.event === "ready"), 5000, "mux event");
assert(true, "a client attaching later still gets the backend's ready event");

a.req(1, "hello", { who: "a" });
b.req(1, "hello", { who: "b" });
await until(() => a.lines.some((l) => l.id === 1) && b.lines.some((l) => l.id === 1), 5000, "mux event");
assert(a.lines.find((l) => l.id === 1).result.echo.who === "a" && b.lines.find((l) => l.id === 1).result.echo.who === "b", "same request id from two clients: each gets its own reply");

a.req(2, "tick", { n: 7 });
await until(() => b.lines.some((l) => l.event === "tick" && l.n === 7), 5000, "mux event");
assert(true, "events reach every attached client");

b.sock.destroy();
await sleep(200);
a.req(3, "hello", { after: "detach" });
await until(() => a.lines.some((l) => l.id === 3), 5000, "mux event");
assert(true, "a client detaching leaves the backend and other clients running");

const pidBefore = a.lines.find((l) => l.event === "ready").pid;
a.req(4, "boom");
await until(() => a.lines.some((l) => l.event === "backend_down"), 5000, "mux event");
await until(() => a.lines.filter((l) => l.event === "ready").length >= 2, 8000, "restart");
const pidAfter = a.lines.filter((l) => l.event === "ready").at(-1).pid;
assert(pidAfter !== pidBefore && a.lines.some((l) => l.id === 4 && l.error), "a crashed backend restarts; its unanswered request gets an error");

let dup = false;
try {
  await runMux({ cwd: dir, backend: { command: process.execPath, args: [fake] } });
} catch {
  dup = true;
}
assert(dup, "a second mux for the same project refuses to start");

a.sock.destroy();
await mux.close();
assert(!(await isLive(mux.path)), "closing the mux stops the backend and removes the socket");
finish("mux");
