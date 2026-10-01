# hive on Windows — setup and first run

Everything runs on your own PC. Nothing listens on the network. Commands below are for **PowerShell**.

## 1. Prerequisites (once)

```powershell
winget install OpenJS.NodeJS.LTS      # Node 22 or newer
winget install Git.Git                # Git for Windows
git config --global core.longpaths true   # worktrees can have long paths
```

Open a new PowerShell window afterwards so `node`, `npm` and `git` are on PATH. Check: `node -v` (v22+), `git --version`.

The vendor CLIs you want to use, logged in with your subscriptions:

```powershell
npm install -g @anthropic-ai/claude-code   ; claude        # log in once (Max/Pro), then /exit
npm install -g @openai/codex               ; codex login   # ChatGPT subscription
```

hive talks to them through their official ACP adapters (bundled with hive, no extra install). The adapters use the logins these CLIs store.

## 2. Get hive

**Quick way (one script):** clone, then let the installer do the rest. It checks Node and Git (and offers to install them with winget), updates, builds, puts `hive` on PATH, builds **hive.exe** (pixel-art icon) with **hive** shortcuts on your Desktop and in the Start menu, checks your agents, and with `-Project` adds a Start-menu entry for that project and opens hive:

Any folder or drive works for hive itself (here `H:\HIVE`). `-Project` is the code the agents should work on, a different folder; if it doesn't exist yet the script offers to create it as an empty git project.

```powershell
git clone https://github.com/visavv/hargent H:\HIVE
cd H:\HIVE
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -Project H:\code\myproject
# later, to update: run the same script again (add -Test to also run the test suite)
```

**Step by step** (what the script does):

```powershell
cd $HOME\code                       # anywhere you keep tools
git clone https://github.com/visavv/hargent hive
cd hive
npm install
npm test                            # ~2 min, uses a built-in mock agent (no logins needed)
npm run build
npm link                            # puts `hive` on your PATH
```

If PowerShell says running scripts is disabled when you type `hive`, either run `hive.cmd …` or allow local scripts once:
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

## 3. First run in one of your projects

```powershell
cd C:\code\myproject
hive doctor          # claude / codex: "proto v1 auth: <your account>" means ready
hive                 # open the app: this folder if it's a project, else the last one (first time: pick a folder)
hive ui              # the pane UI for this project, logs stay in this terminal
```

In the UI: **+ Agent** (Ctrl+N) → pick Claude Code, a name, a preset (Coder gives it its own git worktree) → type in its pane. Hover a pane and talk with Handy; the text goes to that pane.

Terminal alternative:

```powershell
hive chat claude --as coder        # a coder you talk to, in its own worktree
```

## 4. The four everyday setups

```powershell
# (d) a coder you talk to
hive chat claude --as coder

# (a) overnight bug hunt: 8 hours, fresh session each run, notes carried over
hive loop claude --as bughunter --for 8h -d "hunt bugs in src/ and fix one per run"

# (b) security reviewer that rescans when ≥50 lines land (follows coders' branches too)
hive start codex --as security -d

# (c) feature scout every 10 minutes → ideas on the blackboard
hive start claude --as scout -d

# -d only queues jobs; this runs them (keep the window open, or use the UI, which also runs jobs):
hive serve
```

Next morning:

```powershell
hive report --since 12h     # what ran, what each run said, commits on agent branches
hive inbox                  # messages agents sent you
hive worktrees              # agent branches: ahead/behind, diffstat
hive merge <name>           # merge an agent's branch into your checkout
hive bb ideas/              # the scout's ideas
```

## 5. Agents alone or together

- By default agents can message any other agent. Click **only linked** in the sidebar's Groups section (or `hive scope linked`) to keep each agent working on its own until you link it.
- **Link**: drag one pane's name onto another pane (or 🔗). This creates a group with you in it. Click the group chip (`@alpha-beta`) to open its chat.
- **Direct**: they message each other freely. **Review each message**: every agent-to-agent message waits in the group chat until you **Release**, **Edit…** or **Drop** it. **max/h** holds anything over the hourly limit for you to release.
- CLI: `hive link coder reviewer --review`, `hive held`, `hive release 12`.
- Safety default: an agent set to **allow all** only takes mail from agents you linked it with (groups agents make themselves don't count, and agents can't add it to one). Mail from anyone else waits in **✉ Hive → Inbox → Waiting for your review** (Release, Edit, Drop, or **Link & release**). Switch it off under Groups if you really want unlinked agents to drive it.
- `hive accounts` (or the Accounts tab in ✉ Hive) shows which agents are signed in or have their keys.
- **hive.exe / the Desktop icon** opens hive the same way as typing `hive`. Pin it: right-click → Pin to taskbar. It's built from `scripts\windows\hive-launcher.cs` by the installer (re-run the installer after moving the hive folder).
- `hive desktop --cwd C:\code\myproject` adds a Start-menu entry that opens hive on that project.

## 6. Where things are

- hive state (database, layout, agent worktrees): `%LOCALAPPDATA%\hive\projects\<repo>-<hash>\`
- per-job notes the agents read/write: `<your repo>\.hive\notes\` (git-ignored automatically)
- Global hotkey to bring hive to the front on the last pane: **Ctrl+Alt+H** (change with `setx HIVE_HOTKEY "Ctrl+Alt+J"`)

## 7. Local Qwen on the T550

```powershell
npm install -g @qwen-code/qwen-code
setx QWEN_BASE_URL "http://<t550-ip>:11434/v1"
setx QWEN_MODEL "qwen3-coder"
setx QWEN_API_KEY "ollama"
# new PowerShell window, then:
hive doctor qwen
```

## 8. If something goes wrong

- `hive doctor <agent>` shows the adapter's last stderr lines.
- UI won't start: `hive ui` needs `node` on PATH (or `setx HIVE_NODE "C:\Program Files\nodejs\node.exe"`).
- "agent is already running in another hive process": it's open in another `hive chat`, `hive serve` or UI window for the same project. Close that one (leases expire 30 s after a crash).
- Updating hive: `cd $HOME\code\hive; git pull; npm install; npm run build`.
