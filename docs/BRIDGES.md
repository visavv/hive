# Discord & WhatsApp bridges — run hive 24/7 on a server and talk to it from your phone

`hive serve --bridge discord,whatsapp` connects **out** to Discord / WhatsApp. Nothing listens on your server; no port forwarding, no webhooks. Only the user ids / phone numbers you allowlist can command it.

What you can do from chat:

```
status                         agents, what they're doing, unread mail, pending approvals
jobs · stop <job#|agent> · start <job#>
report [12h]                   what ran while you were away
inbox · bb [prefix]            mail agents sent you · blackboard (e.g. bb ideas/ready/)
@coder fix the failing test    message an agent; its reply comes back here
send @dev standup at 10        message a group (or * for everyone)
approve 3 · approve 3 2 · deny 3   answer a permission prompt an agent is waiting on
skill yt-titles transcript=/srv/videos/ep12.srt notes=the failures are the point
help
```

hive pushes to you: mail agents send to "owner", permission prompts, job endings/failures/usage-limit pauses.

## 1. Server (Ubuntu on Proxmox)

```bash
sudo apt update && sudo apt install -y git curl build-essential
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
sudo useradd -m -s /bin/bash hive && sudo -iu hive

git clone https://github.com/visavv/hargent ~/hive && cd ~/hive
git checkout claude/execute-planned-features-loop-9amlre
npm install && npm run build && npm test
```

Log the vendor CLIs in **as the `hive` user** (subscriptions work on a headless box; they print a URL to open on your PC):

```bash
npm i -g @anthropic-ai/claude-code && claude      # /login, then /exit
npm i -g @openai/codex && codex login --device-auth
node ~/hive/dist/cli/index.js doctor
```

Clone the project the agents work on, e.g. `/home/hive/code/myproject`.

## 2. Discord

1. https://discord.com/developers/applications → **New Application** → **Bot** → **Reset Token** → copy it.
2. Same page: enable **Message Content Intent** (only needed if you also use a server channel; DMs work without it).
3. **OAuth2 → URL Generator**: scope `bot`, permissions *Send Messages*, *Read Message History*. Open the URL and add the bot to a private server of yours (needed so you can DM it).
4. Your user id: Discord → Settings → Advanced → Developer Mode on → right-click your name → **Copy User ID**.

```bash
# /home/hive/hive.env   (chmod 600)
HIVE_DISCORD_TOKEN=paste-bot-token
HIVE_DISCORD_ALLOW=123456789012345678        # your user id; comma-separate several
# HIVE_DISCORD_CHANNEL=987654321098765432    # optional: a private channel instead of DMs
# HIVE_BRIDGE_AGENT=studio                   # optional: plain messages go to this agent
```

Try it in a terminal first: `set -a; . ~/hive.env; set +a; node ~/hive/dist/cli/index.js serve --bridge discord --cwd ~/code/myproject` → the bot DMs you "hive connected".

## 3. WhatsApp (read this first)

hive uses **Baileys**, an unofficial WhatsApp Web client, and links as a "device" of a WhatsApp account. WhatsApp can ban numbers that automate — **use a spare number** (a cheap prepaid SIM / WhatsApp Business on a second number), not your personal one. The official WhatsApp Cloud API would need a public HTTPS webhook (an inbound listener), which hive avoids on purpose.

```bash
cd ~/hive && npm install @whiskeysockets/baileys@6.7.24 qrcode-terminal
echo 'HIVE_WHATSAPP_ALLOW=358401234567' >> ~/hive.env    # YOUR number, digits with country code
set -a; . ~/hive.env; set +a
node ~/hive/dist/cli/index.js serve --bridge whatsapp --cwd ~/code/myproject
# scan the QR on the hive phone: WhatsApp → Linked devices → Link a device
```

The login is saved in hive's state dir (`~/.local/state/hive/projects/<repo>-<hash>/whatsapp-auth`), so later starts need no QR. Then message the hive number from your own phone: `status`.

## 4. Run it as a service

```ini
# /etc/systemd/system/hive.service
[Unit]
Description=hive agents
After=network-online.target
Wants=network-online.target

[Service]
User=hive
WorkingDirectory=/home/hive/code/myproject
EnvironmentFile=/home/hive/hive.env
ExecStart=/usr/bin/node /home/hive/hive/dist/cli/index.js serve --bridge discord,whatsapp --cwd /home/hive/code/myproject
Restart=on-failure
RestartSec=10
KillSignal=SIGINT
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now hive
journalctl -u hive -f
```

Set up agents and jobs on the server with the CLI (`hive recipe apply review-loop --agent claude --alt codex`, `hive start claude --as scout -d`, …); `hive serve` runs them.

## Security notes

- Anyone who controls an allowlisted Discord account / phone number can command your agents (including approving permission prompts). Use 2FA on those accounts; keep the allowlist to yourself.
- Messages from everyone else are ignored silently; commands are rate-limited and logged in the hive event log (agent `bridge`).
- The bridge can do what the CLI can: message agents, stop/start jobs, approve prompts, run skills. It can't change agents' permission policies or run shell commands itself.
- Tokens live in the env file (chmod 600), never in the repo or the hive database.
- Discord messages pass through Discord's servers; WhatsApp is end-to-end encrypted between the phones but Baileys keeps the session keys on your server.
