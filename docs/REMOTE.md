# Control hive from your phone (home or away)

Two ways, and they work together:

| | What you get | Works away from home | Opens a port |
|---|---|---|---|
| **Tailscale + SSH + `hive tui`** | the full pane grid: talk to agents, approve prompts, `/add`, `/link`, `/rm` | yes | no |
| **Discord bridge** | pushes (needs you, done, failed, limits) and short commands (`status`, `@coder …`, approve) | yes | no |

Tailscale is a private network between your own devices (free for personal use). Your phone reaches the server at the same address on Wi-Fi at home or on mobile data. Nothing is exposed to the internet and hive still listens on nothing.

## 1. The machine running hive

Best on the always-on Ubuntu server (a home server or VPS), so agents keep working when your PC sleeps.

**Ubuntu / Debian / Fedora** (laptop or server):

```bash
cd ~/hive                                    # the hive checkout
bash scripts/setup-remote.sh --project ~/code/myapp
```

It installs OpenSSH, tmux and Tailscale, asks you to log the machine into Tailscale (a link appears), and creates `hive-tui`: a command that attaches to the running hive session or starts one in tmux. Re-run it any time; it skips what's done.

After your phone's key works (step 2), lock SSH to Tailscale only and turn off passwords:

```bash
bash scripts/setup-remote.sh --project ~/code/myapp --ssh-only-tailscale
```

**Windows desktop** (elevated PowerShell):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-remote-windows.ps1 -TailscaleOnly
```

Windows has no tmux, so a dropped connection closes `hive tui` (agents' sessions resume when you reopen it). For long runs use the server.

Every script has `--dry-run` / `-DryRun` to show what it would do. Both are dry-run in CI on Windows, Ubuntu and Fedora.

## 2. The phone

1. Install **Tailscale** (App Store / Play Store) and sign in with the same account. The server shows up in its device list with a name like `hive-server` and an address `100.x.y.z`.
2. Install an SSH app: **Termius** (iPhone and Android) or **Blink Shell** (iPhone). On Android, **Termux** also works (`pkg install openssh`).
3. In Termius: **Keychain → Generate key** (Ed25519), then **Hosts → New host**: address = the Tailscale name or `100.x.y.z`, username = your Linux user, key = the one you made. Use **Export key to host** once (it asks for your password one time), or paste the public key into `~/.ssh/authorized_keys` on the server.
4. Connect and run:

```bash
hive-tui
```

## 3. Using `hive tui` on a phone

On a narrow screen hive shows **one agent at a time** with the others as tabs along the top: `[2 coder!]  3 tester…  1 planner✓` (`!` needs you, `…` working, `✓` done).

| Do | Type |
|---|---|
| switch agent | `/2` (or Tab, if your SSH app has a Tab key) |
| message the agent on screen | just type, Enter |
| message another agent or a group | `@reviewer check the last commit`, `@squad status?` |
| answer a permission question | `y` or `n` |
| see everyone at once | rotate to landscape (90+ columns shows the grid) |
| cancel a turn | Esc |
| scroll | swipe (tmux mouse mode is on) or PgUp / PgDn |
| leave it running | close the app, or `Ctrl+B` then `D`; `hive-tui` brings you back |

Termius tip: turn on the extra key row (Esc, Tab, Ctrl, arrows) in Settings → Keyboard.

## 4. Pushes on your phone (Discord)

`hive tui` only shows things while you're looking. For a ping when an agent needs you or finishes, add the Discord bridge: create a bot ([docs/BRIDGES.md](BRIDGES.md) §2), then

```bash
bash scripts/setup-remote.sh --project ~/code/myapp --discord
nano ~/hive.env                       # bot token + your Discord user id
sudo systemctl enable --now hive-bridge
```

Run the bridge service **or** an interactive `hive-tui` on a project at a time, not both: they would each start the same agents. A common setup: the bridge runs on the server project; when you want the grid, `sudo systemctl stop hive-bridge && hive-tui`, and start the service again when done.

## Security notes

- Only devices logged into your Tailscale account can reach SSH. With `--ssh-only-tailscale`, port 22 is closed on every other interface and passwords are off.
- Anyone holding your phone with Termius unlocked can drive your agents. Use the app's PIN / biometric lock.
- Agents run as your user on that machine. Prefer `allow-reads` / `ask` policies and worktrees for agents you leave unattended (see the README's permission policy).
