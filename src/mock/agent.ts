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
 */
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type Sess = { mcp: Client[]; cwd: string };
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

let n = 0;
acp
  .agent({ name: "mock-agent" })
  .onRequest("initialize", async () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false, mcpCapabilities: { http: false, sse: false } },
  }))
  .onRequest("authenticate", async () => ({}))
  .onRequest("session/new", async (ctx) => {
    const sessionId = `mock-${Date.now().toString(36)}-${++n}`;
    const mcp = await connectMcp(ctx.params.mcpServers ?? []);
    sessions.set(sessionId, { mcp, cwd: ctx.params.cwd });
    return { sessionId };
  })
  .onRequest("session/set_mode", async () => ({}))
  .onRequest("session/prompt", async (ctx) => {
    const { sessionId, prompt } = ctx.params;
    const sess = sessions.get(sessionId)!;
    const cx = ctx.client;
    const text = prompt.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    const me = process.env.MOCK_NAME ?? "mock";

    // 1. inbox
    await toolCall(cx, sessionId, `t${++n}`, "hive_inbox", "pending", "fetch");
    const inboxRaw = await callTool(sess, "hive_inbox", {});
    await toolCall(cx, sessionId, `t${n}`, "hive_inbox", "completed", "fetch");
    let inbox: any[] = [];
    try {
      inbox = JSON.parse(inboxRaw);
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
    const sendM = text.match(/send (\w+|\*): (.+)/);
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
    if (/agents\?/.test(text)) {
      await say(cx, sessionId, (await callTool(sess, "hive_agents", {})) + "\n");
    }

    // 3. a permission-gated fake edit, to exercise policy
    if (/edit/.test(text)) {
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

    await callTool(sess, "hive_status", { status: "idle", note: `done: ${text.slice(0, 40)}` });
    await say(cx, sessionId, `[${me}] done.`);
    return { stopReason: "end_turn", usage: { totalTokens: 100, inputTokens: 80, outputTokens: 20 } };
  })
  .onNotification("session/cancel", async () => {})
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
