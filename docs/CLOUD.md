# hive in the cloud: one hive, every device


Run hive on one always-on machine and connect to the **same agents, sessions, board and stats** from your desktop, laptop and phone. Close the app on one machine, open it on another, and carry on where you left off. Agents keep working while nobody is connected.

```
 Windows desktop ─┐                         ┌─ hive daemon (keeps the backend running)
 Fedora laptop  ──┼── Tailscale + SSH ──────┤    agents: Claude Code, Codex, Gemini, …
 phone          ──┘   (nothing exposed       │    sessions, transcripts, board.db, usage.db
                       to the internet)      └─ your repos → push to GitHub
```

## Where to run it

| | Good for | Cost |
|---|---|---|
| **Your Proxmox Ubuntu VM** | already always on, local disks, no monthly bill | electricity |
| **A small VPS** (Hetzner, Netcup, OVH, DigitalOcean…) | reachable when the home network is down, fast uplink | a few euros a month |

Size it for the agents, not for hive: each vendor CLI is a Node process using roughly 200–500 MB while it works. **4 GB RAM / 2 vCPU** runs a four-agent squad comfortably; 8 GB if you also build/test big projects there. Ubuntu 24.04 LTS is what the scripts and CI cover.

Your subscriptions work on a server: the vendor CLIs sign in once on that machine (Claude Code shows a login link you open on any device; `codex login --device-auth` does the same). API keys go in the server's environment, never in the repo.

## 1. Set up the server (once)

```bash
# Node 22, git, build tools
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs git build-essential

# hive
git clone https://github.com/visavv/hargent ~/hive && cd ~/hive
npm ci && npm run build && sudo npm link        # puts `hive` on PATH

# the agents you use, then sign in
npm i -g @anthropic-ai/claude-code && claude    # /login, then /exit
npm i -g @openai/codex && codex login --device-auth
hive doctor

# Tailscale + SSH + tmux, and keep hive running for a project
bash scripts/setup-remote.sh --project ~/code/myapp --daemon
```

`--daemon` installs a systemd service (`hive-daemon@<project>`) that starts the project's hive at boot and restarts it if it stops. Clone each project you work on under `~/code/` on the server; add more with `bash scripts/setup-remote.sh --project ~/code/other --daemon`.

## 2. Connect from the desktop app

On Windows or Fedora (Tailscale running and signed in, SSH key set up once with `ssh-copy-id you@hive-server` or by pasting your public key into the server's `~/.ssh/authorized_keys`):

```bash
hive ui --remote you@hive-server --remote-cwd ~/code/myapp
```

The app looks and works the same; the agents, files and git live on the server. If the connection drops (laptop sleeps, Wi-Fi changes) it reconnects on its own and the agents never noticed.

Make it a desktop shortcut: `hive desktop --remote you@hive-server --remote-cwd ~/code/myapp` (Linux) or a Windows shortcut with the same arguments to `hive.cmd ui`.

## 3. Connect from the phone

Today: Tailscale + an SSH app (Termius, Blink, Termux) and `hive-tui` — see [REMOTE.md](REMOTE.md). It talks to the same daemon, board and stats.

The same app in your phone's browser, or as an Android app, served only inside your tailnet: `hive web` ([MOBILE.md](MOBILE.md)).

## 4. Your code

The repos live on the server; agents commit there and you push to GitHub (`git push`, or ask an agent to). To look at code on another machine either use the app (diffs, file views) or `git pull` a local clone. Nothing has to be copied between your devices by hand.

## What lives where

| | On the server | On each device |
|---|---|---|
| agents, sessions, transcripts, jobs | ✓ | – |
| board (Kanban), token stats | ✓ (`board.db`, `usage.db` in hive's home) | – |
| layout (columns, theme) | ✓ per project | – |
| vendor logins, API keys | ✓ | – |
| SSH key, Tailscale login | – | ✓ |

## Commands

```bash
hive daemon --cwd ~/code/myapp      # run in the foreground (what the service runs)
hive attach --cwd ~/code/myapp      # connect stdin/stdout to it (the app runs this over SSH)
hive attach --status --cwd …        # running? how many clients?
hive attach --stop --cwd …          # stop it (agents close; sessions resume next start)
```

## Security

- Nothing listens on the network: the daemon's socket is a file only your user can open. Devices reach it by SSH over Tailscale. `--ssh-only-tailscale` closes SSH everywhere else.
- Anyone with your SSH key and your tailnet can drive your agents. Keep the phone app locked (PIN/biometrics).
- Agents run as your user on the server: keep `ask` / `allow-reads` for agents you leave unattended and give `allow-all` agents their own worktree.
