/**
 * Build chat bridges from environment variables (for `hive serve --bridge …`).
 *
 *   Discord:  HIVE_DISCORD_TOKEN   bot token
 *             HIVE_DISCORD_ALLOW   comma-separated Discord user ids allowed to command hive
 *             HIVE_DISCORD_CHANNEL optional channel id to also listen/notify in (else DMs)
 *   WhatsApp: HIVE_WHATSAPP_ALLOW  comma-separated phone numbers (international, digits)
 *             HIVE_WHATSAPP_AUTH   optional login folder (default: <project state>/whatsapp-auth)
 *   Both:     HIVE_BRIDGE_AGENT    optional agent that gets plain messages (e.g. "studio")
 */
import { join } from "node:path";
import type { Hub } from "../core/hub.js";
import { Bridge } from "./router.js";
import { DiscordTransport } from "./discord.js";
import { WhatsAppTransport, normalizeNumber } from "./whatsapp.js";

const list = (v?: string) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export function createBridges(names: string[], hub: Hub, o: { cwd: string; stateDir: string; env?: NodeJS.ProcessEnv }): Bridge[] {
  const env = o.env ?? process.env;
  const out: Bridge[] = [];
  for (const name of names) {
    if (name === "discord") {
      const allow = list(env.HIVE_DISCORD_ALLOW);
      out.push(
        new Bridge({
          hub,
          transport: new DiscordTransport({ token: env.HIVE_DISCORD_TOKEN ?? "", channel: env.HIVE_DISCORD_CHANNEL || undefined }),
          allow,
          notify: env.HIVE_DISCORD_CHANNEL || undefined,
          cwd: o.cwd,
          defaultAgent: env.HIVE_BRIDGE_AGENT || undefined,
        }),
      );
    } else if (name === "whatsapp") {
      const allow = list(env.HIVE_WHATSAPP_ALLOW).map(normalizeNumber);
      out.push(
        new Bridge({
          hub,
          transport: new WhatsAppTransport({ authDir: env.HIVE_WHATSAPP_AUTH || join(o.stateDir, "whatsapp-auth") }),
          allow,
          cwd: o.cwd,
          defaultAgent: env.HIVE_BRIDGE_AGENT || undefined,
        }),
      );
    } else throw new Error(`unknown bridge "${name}" (discord, whatsapp)`);
  }
  return out;
}
