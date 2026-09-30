/**
 * Discord transport (discord.js). A bot account you create at
 * https://discord.com/developers/applications — outbound gateway connection,
 * nothing listens on your machine.
 *
 * Reads DMs from allowlisted users (and, if HIVE_DISCORD_CHANNEL is set, that
 * channel — needs the Message Content intent enabled for the bot).
 */
import type { ChatTransport, IncomingChat } from "./types.js";

/** The slice of discord.js we use (lets tests inject a fake client). */
export interface DiscordLikeClient {
  on(event: "messageCreate", fn: (msg: any) => void): unknown;
  once(event: "ready" | "clientReady", fn: () => void): unknown;
  login(token: string): Promise<unknown>;
  destroy(): Promise<void> | void;
  channels: { fetch(id: string): Promise<any> };
  users: { fetch(id: string): Promise<any> };
  user?: { id: string } | null;
}

export class DiscordTransport implements ChatTransport {
  readonly name = "discord";
  readonly maxLength = 1900;
  private client?: DiscordLikeClient;

  constructor(
    private o: { token: string; channel?: string; makeClient?: () => Promise<DiscordLikeClient> },
  ) {
    if (!o.token) throw new Error("discord: set HIVE_DISCORD_TOKEN to your bot token");
  }

  async start(onMessage: (m: IncomingChat) => void) {
    this.client = await (this.o.makeClient ?? defaultClient)();
    const c = this.client;
    c.on("messageCreate", (msg: any) => {
      if (msg.author?.bot || (c.user && msg.author?.id === c.user.id)) return;
      const isDm = !msg.guildId;
      if (!isDm && msg.channelId !== this.o.channel) return;
      onMessage({ from: String(msg.author.id), chat: String(msg.channelId), text: String(msg.content ?? "") });
    });
    const ready = new Promise<void>((r) => c.once("clientReady", () => r()));
    await c.login(this.o.token);
    await Promise.race([ready, new Promise((r) => setTimeout(r, 15_000))]);
  }

  async send(to: string, text: string) {
    if (!this.client) throw new Error("discord: not started");
    if (to.startsWith("user:")) {
      const user = await this.client.users.fetch(to.slice(5));
      const dm = await user.createDM();
      await dm.send(text);
      return;
    }
    const ch = await this.client.channels.fetch(to);
    if (!ch?.send) throw new Error(`discord: can't send to channel ${to}`);
    await ch.send(text);
  }

  async stop() {
    await this.client?.destroy();
  }
}

async function defaultClient(): Promise<DiscordLikeClient> {
  let d: any;
  try {
    d = await import("discord.js");
  } catch {
    throw new Error("discord.js is not installed: run `npm install discord.js` in the hive folder");
  }
  const { Client, GatewayIntentBits, Partials } = d;
  return new Client({
    intents: [GatewayIntentBits.DirectMessages, GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel],
  });
}
