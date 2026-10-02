# Security

hive runs coding agents on your machine with access to your code, so security reports matter.

**Please don't open a public issue for a vulnerability.** Use GitHub's private report instead: the repository's **Security** tab → **Report a vulnerability**.

## What hive promises

- **Nothing listens on the network.** The desktop app talks to its backend over stdio. `hive web` binds to 127.0.0.1, and you choose whether to publish it inside your tailnet.
- **Keys stay in the environment** of the hive process. Agents get only what their own vendor CLI needs, and media keys (ElevenLabs, image APIs) are used by hive itself, never handed to agents.
- **Outside content is data.** Mail from other agents, web pages, diffs and file contents are wrapped as untrusted input, and every agent's briefing says so (`src/core/trust.ts`).
- **Permissions are per agent** (`ask`, `allow-reads`, `allow-all`, `reject-all`) on top of each vendor's own sandbox. Mail to a full-access agent from an agent it isn't linked with is held for you.

The audit notes in [audit/](audit/) list what has been checked and what is still open.
