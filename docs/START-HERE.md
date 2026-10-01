# Start here

One page from nothing to using hive every day on your desktop, your server and your phone. Each step links to the detailed guide if you need it.

## 1. Windows desktop (the main app)

1. Install hive: open PowerShell in the hive folder and run
   `powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1`
   (installs Node + Git if missing, builds hive, adds `hive` to your PATH and a Start-menu entry). Details: [WINDOWS.md](WINDOWS.md).
2. Sign in to the agents you pay for, once: `claude` → `/login`; `codex login`; `gemini`. Check with `hive doctor`.
3. Open a project: `hive ui --cwd C:\code\myapp` (or the Start-menu entry).
4. **Ctrl+K** → "Set up a team" → **Squad** (planner, coder, reviewer, tester), or **Ctrl+N** for one agent.

Everyday keys: **Ctrl+K** everything · **Ctrl+1..9** jump to an agent · **Ctrl+J** board · **Ctrl+P** code · **Ctrl+I** inbox · **Ctrl+M** maximize · **Ctrl+Shift+Enter** ✦ improve the prompt you're typing · **Ctrl+Shift+Space** hold to dictate.

## 2. Server (agents keep working when your PC sleeps)

On the Proxmox Ubuntu VM (or any VPS):

```bash
git clone https://github.com/visavv/hargent ~/hive && cd ~/hive && npm ci && npm run build && sudo npm link
claude            # /login (and codex login --device-auth, …)
bash scripts/setup-remote.sh --project ~/code/myapp --daemon --web --ssh-only-tailscale
```

That installs Tailscale + SSH, keeps the project's hive running (`--daemon`) and serves the phone app inside your tailnet (`--web`). Details: [CLOUD.md](CLOUD.md).

From the desktop, open the same agents: `hive ui --remote you@hive-server --remote-cwd ~/code/myapp`.

## 3. Phone (Android)

1. Install **Tailscale** on the phone and sign in with the same account.
2. On the server, `hive web` printed a link like `https://hive-server.tailXXXX.ts.net/#t=…` (also in `~/.local/state/hive/projects/*/web-token`).
3. Either open it in Chrome → menu → **Add to Home screen**, or install the **APK**: GitHub → Actions → latest green run → Artifacts → `hive-android-apk`, open it on the phone, paste the link on first start.

Details: [MOBILE.md](MOBILE.md). Terminal fallback over SSH: [REMOTE.md](REMOTE.md).

## 4. Optional extras

| | Guide |
|---|---|
| Dictation (local Whisper/Parakeet, OpenAI, ElevenLabs, Groq, NVIDIA) and spoken replies | [VOICE.md](VOICE.md) |
| Learn while you build: code view, teacher with the hint ladder | [LEARN.md](LEARN.md) |
| Sandboxed browser and Android device panes | [DEVICES.md](DEVICES.md) |
| DaVinci Resolve and other MCP servers per agent | [MCP.md](MCP.md) |
| Twitch clips → board, Three.js animations → video | [CREATOR.md](CREATOR.md) |
| API models (Gemini, OpenRouter/Llama, Ollama…) | [MODELS.md](MODELS.md) |
| Verdict mode (several agents, one judge) | [VERDICT.md](VERDICT.md) |
| Discord / WhatsApp pushes | [BRIDGES.md](BRIDGES.md) |

## 5. Money and safety

- **Token stats** (Ctrl+K → Token stats, or `hive stats`): where tokens go by provider, model, task and project.
- **Spending guards** (Ctrl+I → Usage): daily caps, reserve before limit windows, pause all automatic work.
- Keys live only in environment variables; agents never see bridge tokens or other providers' keys. Agents that may run anything get their own git worktree; mail to them from unlinked agents waits for you.
- Nothing listens on the internet: remote access goes through Tailscale (SSH, `tailscale serve`).

## Updating

`git pull && npm ci && npm run build` in the hive folder (on Windows re-run the install script). Re-download the APK from the newest green CI run when the phone app changes (uninstall the old one first: CI builds use a fresh debug key).
