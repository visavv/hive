#!/usr/bin/env node
/**
 * Mock ACP agent for testing the hub without any vendor auth.
 *
 * It behaves like a tiny scripted model:
 *  - connects to every MCP server it's handed in session/new (so the hive
 *    tools are exercised for real)
 *  - on each prompt: calls hive_inbox; for every message addressed to it,
 *    replies via hive_send; if the prompt contains "send <name>: <text>" it
 *    sends that; if it contains "bb <k>=<v>" it writes the blackboard;
 *    streams a short text reply; asks permission for one fake write.
 *  - "slow" waits up to 10 s, or until session/cancel → stopReason "cancelled"
 *  - "ask?" sends elicitation/create and reports the answer
 *  - "Read and update <file>.md" (the scheduler's notes line) reads the file
 *    through the client's fs/read_text_file and appends one line with
 *    fs/write_text_file, so notes persistence is tested end to end
 *  - supports session/load, session/resume and session/close
 */
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { demoTurn } from "./demo.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type Sess = { mcp: Client[]; cwd: string; turns: number; cancelled: boolean; how: string; wake?: () => void };
const sessions = new Map<string, Sess>();

async function connectMcp(servers: acp.McpServer[]): Promise<Client[]> {
  const out: Client[] = [];
  for (const s of servers) {
    if (!("command" in s)) continue;
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    for (const e of s.env) env[e.name] = e.value;
    const transport = new StdioClientTransport({ command: s.command, args: s.args, env, stderr: "inherit" });
    const c = new Client({ name: "mock-agent", version: "0" });
    await c.connect(transport);
    out.push(c);
  }
  return out;
}

async function callTool(sess: Sess, name: string, args: Record<string, unknown>): Promise<string> {
  for (const c of sess.mcp) {
    const tools = await c.listTools();
    if (tools.tools.some((t) => t.name === name)) {
      const r = await c.callTool({ name, arguments: args });
      const first = (r.content as any[])?.[0];
      return first?.type === "text" ? first.text : JSON.stringify(r.content);
    }
  }
  return `(no tool ${name})`;
}

const say = (cx: acp.AgentContext, sessionId: string, text: string) =>
  cx.notify(acp.methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  });

const toolCall = (cx: acp.AgentContext, sessionId: string, id: string, title: string, status: "pending" | "completed", kind: any = "other") =>
  cx.notify(acp.methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: "tool_call", toolCallId: id, title, kind, status },
  });

const configOptions = [
  {
    id: "model",
    name: "Model",
    type: "select" as const,
    currentValue: "mock-small",
    options: [
      { value: "mock-small", name: "Mock Small" },
      { value: "mock-large", name: "Mock Large" },
    ],
  },
];

async function openSess(sessionId: string, cwd: string, servers: acp.McpServer[], how: string) {
  const old = sessions.get(sessionId);
  if (old) for (const c of old.mcp) await c.close().catch(() => {});
  const mcp = await connectMcp(servers);
  sessions.set(sessionId, { mcp, cwd, turns: 0, cancelled: false, how });
}

// MOCK_MODEL="Label" renames the model option (demo screenshots).
if (process.env.MOCK_MODEL) configOptions[0].options[0].name = process.env.MOCK_MODEL;

// MOCK_NO_RESUME=1 → advertise only session/load (tests the replay path).
const noResume = process.env.MOCK_NO_RESUME === "1";

let n = 0;
let rateLimited = false;
acp
  .agent({ name: "mock-agent" })
  .onRequest("initialize", async (ctx) => {
    // like claude-agent-acp: push identity shortly after initialize
    setTimeout(() => void ctx.client.notify("_auth/status_update", { authStatus: { kind: "mock", label: "Mock login" } }), 50);
    return {
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: true,
      mcpCapabilities: { http: false, sse: false },
      sessionCapabilities: { close: {}, ...(noResume ? {} : { resume: {} }) },
      _meta: { authStatus: {} },
    },
    agentInfo: { name: "mock-agent", version: "0.0.1" },
    };
  })
  .onRequest("authenticate", async () => ({}))
  .onRequest("session/new", async (ctx) => {
    const sessionId = `mock-${Date.now().toString(36)}-${++n}`;
    await openSess(sessionId, ctx.params.cwd, ctx.params.mcpServers ?? [], "new");
    // slash commands, as Claude Code advertises them (the composer's "/" menu)
    const client = ctx.client;
    setTimeout(() => {
      void client
        .notify(acp.methods.client.session.update, {
          sessionId,
          update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "Summarize the conversation to free up context" }, { name: "review", description: "Review the current changes", input: { hint: "focus" } }] } as any,
        })
        .catch(() => {});
    }, 50);
    return { sessionId, configOptions };
  })
  .onRequest("session/resume", async (ctx) => {
    await openSess(ctx.params.sessionId, ctx.params.cwd, ctx.params.mcpServers ?? [], "resumed");
    return { configOptions };
  })
  .onRequest("session/load", async (ctx) => {
    const { sessionId } = ctx.params;
    await openSess(sessionId, ctx.params.cwd, ctx.params.mcpServers ?? [], "loaded");
    // replay a bit of "history", as real agents do
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "(replayed history)" } },
    });
    return { configOptions };
  })
  .onRequest("session/close", async (ctx) => {
    const s = sessions.get(ctx.params.sessionId);
    if (s) for (const c of s.mcp) await c.close().catch(() => {});
    sessions.delete(ctx.params.sessionId);
    return {};
  })
  .onRequest("session/set_config_option", async (ctx) => {
    const p = ctx.params as any;
    configOptions[0].currentValue = String(p.value);
    return { configOptions };
  })
  .onRequest("session/set_mode", async () => ({}))
  .onRequest("session/prompt", async (ctx) => {
    const { sessionId, prompt } = ctx.params;
    const sess = sessions.get(sessionId)!;
    const cx = ctx.client;
    const text = prompt.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    const me = process.env.MOCK_NAME ?? "mock";
    if (process.env.MOCK_FAIL === "1") throw new Error("mock adapter is broken");
    if (/ratelimit-once/.test(text) && !rateLimited) {
      rateLimited = true;
      throw new Error("Claude usage limit reached. Your limit resets in 1 seconds.");
    }
    sess.turns++;
    sess.cancelled = false;
    // the ✦ improve helper (core/improve.ts): echo the draft back as a "better" prompt
    if (/You are a prompt engineer\. The owner is about to send/.test(text)) {
      const draft = text.match(/The owner's draft:\n<<<\n([\s\S]*?)\n>>>/)?.[1] ?? "";
      const lastOwner = [...text.matchAll(/OWNER: (.+)/g)].at(-1)?.[1] ?? "none";
      await say(cx, sessionId, "```text\nIMPROVED: " + draft + "\nContext seen: " + lastOwner + "\nCheck your work with the tests and report what changed.\n```");
      return { stopReason: "end_turn", usage: { totalTokens: 50, inputTokens: 40, outputTokens: 10 } };
    }
    // the learning helper (core/memory.ts): learn "always/never/prefer" lines the owner said; a skill when repeats were listed
    if (/You are hive's learning helper/.test(text)) {
      const convo = text.match(/<<<\n([\s\S]*?)\n>>>/)?.[1] ?? "";
      const said = [...convo.matchAll(/^OWNER: (.*)$/gm)].map((m) => m[1]);
      const pref = said.find((l) => /\b(always|never|prefer)\b/i.test(l));
      const owner = pref ? [pref.replace(/^(please\s+)?/i, "").slice(0, 150)] : [];
      const skill = /skill candidates/.test(text) ? { name: "repeat-task", description: "The thing you keep asking for", params: ["topic"], body: "Do the usual steps for {{topic}} and report back.", reason: "asked 3 times" } : null;
      await say(cx, sessionId, "```json\n" + JSON.stringify({ owner, project: [], skill }) + "\n```");
      return { stopReason: "end_turn", usage: { totalTokens: 60, inputTokens: 50, outputTokens: 10 } };
    }
    if (process.env.MOCK_DEMO === "1") {
      const ask = async (title: string, kind: string, content?: unknown[]) => {
        const perm: any = await cx.request(acp.methods.client.session.requestPermission, {
          sessionId,
          toolCall: { toolCallId: `t${++n}`, title, kind: kind as any, status: "pending", content: content as any },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        });
        return perm.outcome.outcome === "selected" && perm.outcome.optionId === "allow";
      };
      const r = await demoTurn(cx, sessionId, text, (name, args) => callTool(sess, name, args), ask, me);
      return { stopReason: "end_turn", usage: { totalTokens: r.tokens, inputTokens: Math.round(r.tokens * 0.8), outputTokens: Math.round(r.tokens * 0.2) } };
    }
    if (sess.turns === 1 && sess.how !== "new") await say(cx, sessionId, `(${sess.how} session ${sessionId})\n`);

    // 1. inbox (MOCK_DEAF=1: an agent that never reads its mail)
    await toolCall(cx, sessionId, `t${++n}`, "hive_inbox", "pending", "fetch");
    const inboxRaw = process.env.MOCK_DEAF === "1" ? "[]" : await callTool(sess, "hive_inbox", {});
    await toolCall(cx, sessionId, `t${n}`, "hive_inbox", "completed", "fetch");
    let inbox: any[] = [];
    // Like a model reading hive_inbox: skip the trust note, read through the untrusted markers.
    const unwrap = (v: any) => (typeof v === "string" ? v.replace(/^<<untrusted[^\n]*>>\n/, "").replace(/\n<<end untrusted>>$/, "") : v);
    try {
      inbox = JSON.parse(inboxRaw.slice(inboxRaw.indexOf("["))).map((m: any) => ({ ...m, subject: unwrap(m.subject), body: unwrap(m.body) }));
    } catch {}
    for (const m of inbox) {
      if (m.subject?.startsWith("re:")) {
        await say(cx, sessionId, `Got mail from ${m.from}: "${m.subject}" (reply, noted).\n`);
        continue; // don't ping-pong forever
      }
      await say(cx, sessionId, `Got mail from ${m.from}: "${m.subject}". Replying.\n`);
      await callTool(sess, "hive_send", {
        to: m.from,
        subject: `re: ${m.subject}`,
        body: `ack from ${me}: ${m.body.slice(0, 60)}`,
        thread: m.thread,
      });
    }

    // 2. scripted commands in the prompt
    const ownerM = text.match(/tellowner: (.+)/);
    if (ownerM) await say(cx, sessionId, (await callTool(sess, "hive_send", { to: "owner", subject: "fyi", body: ownerM[1] })) + "\n");
    const grpM = text.match(/grp (create|add) ([\w.-]+) ([\w., -]+)/);
    if (grpM) await say(cx, sessionId, (await callTool(sess, "hive_group", { action: grpM[1], name: grpM[2], members: grpM[3].split(/[ ,]+/).filter(Boolean) })) + "\n");
    const fuM = text.match(/followup (\d+)(?: for (\w+))?: (.+)/);
    if (fuM) await say(cx, sessionId, (await callTool(sess, "hive_followup", { in_minutes: Number(fuM[1]), prompt: fuM[3], ...(fuM[2] ? { agent: fuM[2] } : {}) })) + "\n");
    const sendM = text.match(/(?<!tell)send (@?[\w.-]+|\*): (.+)/);
    if (sendM) {
      await toolCall(cx, sessionId, `t${++n}`, `hive_send → ${sendM[1]}`, "pending");
      const r = await callTool(sess, "hive_send", { to: sendM[1], subject: "task", body: sendM[2] });
      await toolCall(cx, sessionId, `t${n}`, `hive_send → ${sendM[1]}`, "completed");
      await say(cx, sessionId, `${r}\n`);
    }
    const bbM = text.match(/bb (\S+)=(.+)/);
    if (bbM) {
      await callTool(sess, "hive_bb_set", { key: bbM[1], value: bbM[2] });
      await say(cx, sessionId, `blackboard ${bbM[1]} set\n`);
    }
    const skillW = text.match(/Write a hive skill file named "([\w.-]+)"/);
    if (skillW)
      await say(
        cx,
        sessionId,
        "Here you go:\n```markdown\n---\nname: " +
          skillW[1] +
          "\ndescription: written by the mock\nagent: claude\npolicy: reject-all\nparams:\n  - name: topic\n    type: text\n    required: true\n---\nWrite about {{topic}}.\n```\n",
      );
    if (/Write \d+ title options/.test(text)) await say(cx, sessionId, "1. A title [curiosity]\n2. Another title [outcome]\n");
    if (/\bhostile-img\b/.test(text)) await say(cx, sessionId, "look: ![leak](//localhost/etc/hostname) and ![x](file:///etc/passwd)\n");
    const diffM = text.match(/hivediff (\w+)(?: branch=(\S+))?/);
    if (diffM)
      await say(cx, sessionId, (await callTool(sess, "hive_diff", { agent: diffM[1], stat_only: true, ...(diffM[2] ? { branch: diffM[2] } : {}) })) + "\n");
    // verdict mode: a contender writes a file in its worktree; the judge names a base
    if (/verdict-task/.test(text) && !/You are the judge/.test(text) && !/Build the final version/.test(text)) {
      writeFileSync(join(sess.cwd, "solution.txt"), `solution by ${sessionId}\n`);
      await say(cx, sessionId, "approach: wrote solution.txt\n");
    }
    if (/You are the judge in a verdict round/.test(text)) {
      const n = (text.match(/## Solution [A-H]/g) ?? []).length;
      await say(cx, sessionId, `VERDICT: base = Solution A\n| solution | correctness |\n|---|---|\n${n} solutions compared; untrusted-wrapped: ${/<<untrusted solution A/.test(text)}; saw diff: ${/solution\.txt/.test(text)}\n`);
    }
    if (/Build the final version/.test(text)) {
      writeFileSync(join(sess.cwd, "solution.txt"), "merged solution\n");
      await say(cx, sessionId, "built the merged version\n");
    }
    // "calltool <name> {json}" calls any MCP tool it was given and prints the result
    const ctM = text.match(/calltool (\w+) (\{.*\})/);
    if (ctM) await say(cx, sessionId, `tool ${ctM[1]}: ${await callTool(sess, ctM[1], JSON.parse(ctM[2]))}\n`);
    if (/agents\?/.test(text)) {
      await say(cx, sessionId, (await callTool(sess, "hive_agents", {})) + "\n");
    }

    // 3. a permission-gated fake edit, to exercise policy
    if (/\bhivetool\b/.test(text)) {
      const perm = await cx.request(acp.methods.client.session.requestPermission, {
        sessionId,
        toolCall: { toolCallId: `t${++n}`, title: "mcp__hive__hive_send", kind: "other", status: "pending" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      });
      await say(cx, sessionId, perm.outcome.outcome === "selected" && perm.outcome.optionId === "allow" ? "hive tool allowed\n" : "hive tool rejected\n");
    }
    if (/\bedit\b/.test(text) && !/Read and update/.test(text)) {
      const perm = await cx.request(acp.methods.client.session.requestPermission, {
        sessionId,
        toolCall: { toolCallId: `t${++n}`, title: "Write src/fake.ts", kind: "edit", status: "pending" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      });
      const ok = perm.outcome.outcome === "selected" && perm.outcome.optionId === "allow";
      await say(cx, sessionId, ok ? "edit allowed, wrote file\n" : "edit rejected\n");
    }

    // 4. a structured question to the user
    if (/ask\?/.test(text)) {
      const r: any = await cx.request(acp.methods.client.elicitation.create, {
        sessionId,
        mode: "form",
        message: "What is the answer?",
        requestedSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
      } as any);
      await say(cx, sessionId, `elicit: ${r.action} ${JSON.stringify((r as any).content ?? null)}\n`);
    }

    // 5. scheduler notes file: read it through the client and append a line.
    // Like a real agent, ask permission for the edit first (allow-reads jobs must be allowed).
    const notesM = text.match(/Read and update (\S+\.md)/);
    if (notesM) {
      const perm = await cx.request(acp.methods.client.session.requestPermission, {
        sessionId,
        toolCall: { toolCallId: `t${++n}`, title: `Edit ${notesM[1]}`, kind: "edit", status: "pending", locations: [{ path: notesM[1] }] },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      });
      if (!(perm.outcome.outcome === "selected" && perm.outcome.optionId === "allow")) {
        await say(cx, sessionId, "notes edit rejected\n");
      } else {
      const path = notesM[1];
      const head = await cx.request(acp.methods.client.fs.readTextFile, { sessionId, path, line: 1, limit: 1 });
      const all = await cx.request(acp.methods.client.fs.readTextFile, { sessionId, path });
      await cx.request(acp.methods.client.fs.writeTextFile, {
        sessionId,
        path,
        content: all.content.trimEnd() + `\n- iteration by ${sessionId} (turn ${sess.turns})\n`,
      });
      await say(cx, sessionId, `notes head: ${head.content}\n`);
      }
    }

    // 6. a long turn that honours session/cancel
    if (/\bslow\b/.test(text)) {
      await say(cx, sessionId, "working slowly…\n");
      await new Promise<void>((r) => {
        const t = setTimeout(r, 10_000);
        sess.wake = () => {
          clearTimeout(t);
          r();
        };
      });
      sess.wake = undefined;
      if (sess.cancelled) return { stopReason: "cancelled" };
    }

    // Like claude-agent-acp: usage with cost, and (on request) the subscription's rate-limit window.
    const rlM = text.match(/ratelimit-meta (\d+)/);
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "usage_update",
        used: 1000 * sess.turns,
        size: 200_000,
        cost: { amount: 0.01 * sess.turns, currency: "USD" },
        ...(rlM
          ? { _meta: { "_claude/rateLimit": { status: "allowed_warning", rateLimitType: "five_hour", utilization: Number(rlM[1]) / 100, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } }
          : {}),
      } as any,
    });

    await callTool(sess, "hive_status", { status: "idle", note: `done: ${text.slice(0, 40)}` });
    await say(cx, sessionId, `[${me}] done.`);
    return { stopReason: "end_turn", usage: { totalTokens: 100, inputTokens: 80, outputTokens: 20 } };
  })
  .onNotification("session/cancel", async (ctx) => {
    const s = sessions.get(ctx.params.sessionId);
    if (!s) return;
    s.cancelled = true;
    s.wake?.();
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));

// Like the real adapters: exit when the client goes away (stdin EOF).
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
