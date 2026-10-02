/**
 * WhatsApp transport via Baileys (WhatsApp Web multi-device protocol).
 *
 * Important: this is an UNOFFICIAL client. It links hive as a device of a
 * WhatsApp account (scan a QR once). WhatsApp may ban numbers that automate;
 * use a spare number, not your main one. The official Cloud API needs a
 * public HTTPS webhook (an inbound listener), which hive avoids by design.
 *
 * Outbound connection only; the login is stored in the project's state dir.
 * Install on the server: `npm install @whiskeysockets/baileys@6.7.24`.
 */
import type { ChatTransport, IncomingChat } from "./types.js";

/** The slice of Baileys we use (tests inject a fake). */
export interface WASocketLike {
  ev: { on(event: string, fn: (arg: any) => void): void };
  sendMessage(jid: string, content: { text: string }): Promise<unknown>;
  end?(err?: Error): void;
  logout?(): Promise<void>;
}

export type MakeSocket = (onQr: (qr: string) => void) => Promise<WASocketLike>;

/** "15550100001" or "+1 555 010 0001" → "15550100001" */
export function normalizeNumber(n: string): string {
  return n.replace(/[^\d]/g, "");
}

export class WhatsAppTransport implements ChatTransport {
  readonly name = "whatsapp";
  readonly maxLength = 3500;
  private sock?: WASocketLike;
  private onMessage?: (m: IncomingChat) => void;
  private stopped = false;
  private reconnects = 0;

  constructor(private o: { authDir: string; makeSocket?: MakeSocket; onQr?: (qr: string) => void }) {}

  async start(onMessage: (m: IncomingChat) => void) {
    this.onMessage = onMessage;
    await this.connect();
  }

  private async connect() {
    const make = this.o.makeSocket ?? ((onQr) => defaultSocket(this.o.authDir, onQr));
    const sock = await make((qr) => (this.o.onQr ?? printQr)(qr));
    this.sock = sock;
    sock.ev.on("messages.upsert", (u: any) => {
      if (u?.type && u.type !== "notify") return;
      for (const msg of u?.messages ?? []) {
        if (msg.key?.fromMe) continue;
        const jid: string = msg.key?.remoteJid ?? "";
        if (!jid.endsWith("@s.whatsapp.net")) continue; // direct chats only, no groups
        const text = msg.message?.conversation ?? msg.message?.extendedTextMessage?.text ?? "";
        if (!text) continue;
        this.onMessage?.({ from: normalizeNumber(jid.split("@")[0]), chat: jid, text });
      }
    });
    sock.ev.on("connection.update", (u: any) => {
      // A working connection starts the retry count over (20 in a row, not 20 in the bridge's life).
      if (u?.connection === "open") this.reconnects = 0;
      if (u?.connection !== "close" || this.stopped) return;
      const code = u.lastDisconnect?.error?.output?.statusCode;
      if (code === 401) {
        console.error("whatsapp: logged out — delete the auth folder and scan the QR again");
        return;
      }
      if (this.reconnects++ < 20) setTimeout(() => void this.connect().catch((e) => console.error(`whatsapp: ${e?.message ?? e}`)), Math.min(60_000, 2000 * this.reconnects));
    });
  }

  async send(to: string, text: string) {
    if (!this.sock) throw new Error("whatsapp: not started");
    const jid = to.startsWith("user:") ? `${normalizeNumber(to.slice(5))}@s.whatsapp.net` : to;
    await this.sock.sendMessage(jid, { text });
  }

  async stop() {
    this.stopped = true;
    this.sock?.end?.(undefined);
  }
}

function printQr(qr: string) {
  console.log("whatsapp: scan this QR with WhatsApp → Linked devices → Link a device:");
  import("qrcode-terminal" as string)
    .then((m: any) => (m.default ?? m).generate(qr, { small: true }))
    .catch(() => console.log(`${qr}\n(install qrcode-terminal to draw it here, or paste this string into any QR generator)`));
}

async function defaultSocket(authDir: string, onQr: (qr: string) => void): Promise<WASocketLike> {
  let b: any;
  try {
    b = await import("@whiskeysockets/baileys" as string);
  } catch {
    throw new Error("Baileys is not installed: run `npm install @whiskeysockets/baileys@6.7.24` in the hive folder");
  }
  const makeWASocket = b.default ?? b.makeWASocket;
  const { state, saveCreds } = await b.useMultiFileAuthState(authDir);
  const sock = makeWASocket({ auth: state, printQRInTerminal: false, browser: b.Browsers?.ubuntu?.("hive") });
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", (u: any) => u?.qr && onQr(u.qr));
  return sock;
}
