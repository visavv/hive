# hive on Linux (Fedora laptop, Ubuntu server)

Same app as on Windows: the pane UI (`hive ui`), the CLI, jobs, skills, groups, bridges. Nothing listens on the network.

## Fedora (Workstation 41/42, GNOME or KDE)

```bash
sudo dnf install -y nodejs git gcc-c++ make python3     # Node 22+ (Fedora's nodejs is 22); compilers only for a native-module fallback
node -v                                                 # v22 or newer

# global npm packages without sudo
npm config set prefix ~/.local
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc

git clone https://github.com/visavv/hargent ~/code/hive && cd ~/code/hive
git checkout claude/execute-planned-features-loop-9amlre
npm install && npm run build && npm link                # `hive` on PATH
npm test                                                # optional, ~3 min, mock agents only
```

The Electron UI needs the usual desktop libraries (GTK3, NSS, ALSA). Fedora Workstation already has them. On a minimal install, run `sudo dnf install -y gtk3 nss alsa-lib libXScrnSaver mesa-libgbm`.

### Sign in on the laptop (once)

Subscriptions work on more than one machine. Log the CLIs in on the laptop too:

```bash
npm i -g @anthropic-ai/claude-code && claude      # /login, then /exit
npm i -g @openai/codex && codex login
hive accounts                                      # ✓ = ready; "!" lines say how to fix
```

Logins live in your home directory (`~/.claude`, `~/.codex`). API keys go in your environment, e.g. in `~/.bashrc`, or `~/.config/environment.d/hive.conf` so GNOME-launched apps see them too:

```bash
mkdir -p ~/.config/environment.d
cat >> ~/.config/environment.d/hive.conf <<'EOF'
GEMINI_API_KEY=...
OPENROUTER_API_KEY=...
EOF
# log out and back in once
```

### Open it

```bash
cd ~/code/myproject && hive ui
hive desktop --cwd ~/code/myproject     # adds "hive — myproject" to the app menu
```

### Wayland notes (GNOME / KDE default)

- The window runs natively on Wayland. If something looks off, force X11 with `ELECTRON_OZONE_PLATFORM_HINT=x11 hive ui`.
- The global "bring hive to front" hotkey (Ctrl+Alt+H) goes through the desktop's shortcut portal; GNOME asks once. If your desktop doesn't offer that, add a custom shortcut in Settings → Keyboard that runs `hive ui --cwd ~/code/myproject`.
- Notifications and the "ready" chime use the normal desktop notification and PipeWire audio.

## Where things are

- hive state: `~/.local/state/hive/projects/<repo>-<hash>/` (database, layout, agent worktrees). Override with `HIVE_HOME`.
- Custom providers: `~/.local/state/hive/agents.json`. User skills: `~/.local/state/hive/skills/`.

## Windows desktop + Fedora laptop + Proxmox server

Each machine runs its own hive. Projects travel through git as usual; agent branches (`hive/<name>`) are normal branches you can push. For a hive that keeps running when the laptop sleeps, use the server (docs/BRIDGES.md) and talk to it from Discord or WhatsApp.

## Troubleshooting

- `npm install` fails building better-sqlite3: install `gcc-c++ make python3` (above) and run `npm install` again.
- UI doesn't open over SSH or as root: it needs a desktop session. When run as root, `hive ui` adds `--no-sandbox` itself.
- `hive doctor` shows what each agent reports. `hive doctor claude` also prints the adapter's last error lines.
