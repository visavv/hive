#!/usr/bin/env node
/**
 * hive CLI — enough to drive the hub from a terminal until the pane UI exists.
 *
 *   hive run <agent> [--name X] [--cwd DIR] [--role R] [--policy P] "prompt"
 *   hive chat <agent> [...]           interactive; type prompts, /quit to exit
 *   hive agents                       list hive members (from the db)
 *   hive doctor                       check which agent binaries are installed
 */
import { parseArgs } from "node:util";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { Hub } from "../core/hub.js";
import { AGENTS } from "../core/agents.js";
import type { SessionEvent } from "../core/session.js";
import { HiveDb } from "../hive/db.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    cwd: { type: "string", default: process.cwd() },
    role: { type: "string", default: "" },
    policy: { type: "string", default: "ask" },
    db: { type: "string", default: ".hive/hive.db" },
    quiet: { type: "boolean", default: false },
  },
});
const [cmd, ...rest] = positionals;

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

function render(agent: string, e: SessionEvent) {
  const tag = cyan(`[${agent}]`);
  switch (e.type) {
    case "text":
      process.stdout.write(e.text);
      break;
    case "thought":
      if (!values.quiet) process.stdout.write(dim(e.text));
      break;
    case "tool_call":
      console.log(`\n${tag} ${yellow("⚙")} ${e.title} ${dim(e.status)}`);
      break;
    case "tool_update":
      if (e.status === "completed" || e.status === "failed") console.log(`${tag} ${dim(`⚙ ${e.id} ${e.status}`)}`);
      break;
    case "permission":
      console.log(`${tag} ${yellow("🔐")} ${e.title} → ${e.decision}`);
      break;
    case "turn_end":
      console.log(`\n${tag} ${dim(`— ${e.stopReason}${e.usage ? " " + JSON.stringify(e.usage) : ""}`)}`);
      break;
    case "status":
      if (e.status === "error") console.error(`${tag} ERROR ${e.note}`);
      else if (!values.quiet) console.log(`${tag} ${dim(`${e.status}${e.note ? ": " + e.note : ""}`)}`);
      break;
    case "notice":
      if (!values.quiet) console.error(`${tag} ${dim(e.text)}`);
      break;
    case "exit":
      console.log(`${tag} exited ${e.code}`);
      break;
  }
}

async function askPermission(req: any): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`\n🔐 ${req.toolCall.title}`);
  req.options.forEach((o: any, i: number) => console.log(`  ${i + 1}. ${o.name} (${o.kind})`));
  const a = await rl.question("choose: ");
  rl.close();
  const i = parseInt(a.trim(), 10) - 1;
  return req.options[i]?.optionId ?? req.options.find((o: any) => o.kind.startsWith("reject"))?.optionId;
}

async function main() {
  switch (cmd) {
    case "agents": {
      const db = new HiveDb(values.db);
      console.table(db.listAgents().map(({ name, kind, role, status, status_note, cwd }) => ({ name, kind, role, status, note: status_note, cwd })));
      db.close();
      return;
    }
    case "doctor": {
      for (const a of Object.values(AGENTS)) {
        const probe = a.command.startsWith("npx") ? a.args[1] : a.command;
        const r = spawnSync(process.platform === "win32" ? "where" : "which", [probe]);
        const ok = a.command.startsWith("npx") ? "npx (fetched on demand)" : r.status === 0 ? "ok" : "missing";
        console.log(`${a.id.padEnd(9)} ${ok.padEnd(24)} ${dim(a.install)}`);
      }
      return;
    }
    case "run":
    case "chat": {
      const agent = rest[0];
      if (!agent || !AGENTS[agent]) {
        console.error(`usage: hive ${cmd} <${Object.keys(AGENTS).join("|")}> [--name N] [--cwd D] [--role R] [--policy ask|allow-reads|allow-all] "prompt"`);
        process.exit(1);
      }
      const name = values.name ?? agent;
      const hub = new Hub({ hiveDb: values.db, onEvent: render });
      const s = await hub.add({
        name,
        agent,
        cwd: values.cwd!,
        role: values.role,
        policy: values.policy as any,
        askPermission,
      });
      hub.run();
      if (cmd === "run") {
        await s.prompt(rest.slice(1).join(" ") || "hello");
        await hub.settle();
        await hub.close();
        return;
      }
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      for (;;) {
        const line = await rl.question(`\n${cyan(name)}> `);
        if (line.trim() === "/quit") break;
        if (line.trim()) await s.prompt(line);
      }
      rl.close();
      await hub.close();
      return;
    }
    default:
      console.log(`hive <run|chat|agents|doctor>`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
