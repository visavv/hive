/** A chat network hive can be reached through (Discord, WhatsApp, a test fake). */
export interface IncomingChat {
  /** Sender id (Discord user id, WhatsApp number). Checked against the allowlist. */
  from: string;
  /** Where to reply (channel / chat id). */
  chat: string;
  text: string;
}

export interface ChatTransport {
  readonly name: string;
  /** Longest message the network accepts; longer texts are split. */
  readonly maxLength: number;
  start(onMessage: (m: IncomingChat) => void): Promise<void>;
  /** Send to a chat id, or "user:<id>" for a direct message to an allowed user. */
  send(to: string, text: string): Promise<void>;
  stop(): Promise<void>;
}
