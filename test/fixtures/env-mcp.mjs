#!/usr/bin/env node
// Tiny stdio MCP server for test/mcp-extra.ts: one tool that reports which env vars it can see.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "env-probe", version: "0" });
server.registerTool("env_probe", { description: "report selected env vars", inputSchema: {} }, async () => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({
        token: process.env.PROBE_TOKEN ?? null,
        eleven: process.env.ELEVENLABS_API_KEY ?? null,
        twitch: process.env.TWITCH_CLIENT_SECRET ?? null,
        arg: process.argv[2] ?? null,
      }),
    },
  ],
}));
await server.connect(new StdioServerTransport());
