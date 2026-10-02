<p align="center">
  <img src="assets/hive.png" width="128" height="128" alt="hive icon: a bee on a honeycomb">
</p>

<h1 align="center">hive</h1>

<p align="center">
  <b>Your AI coding agents, working as a team and checking each other's work.</b><br>
  Runs on your computer · uses the subscriptions you already have · free and open source
</p>

> 🚧 **Work in progress**

![Four agents working together: planner, coder, reviewer, tester](docs/screenshots/03-squad.png)

## What it does

- **Agents review each other.** One agent writes the code, another checks it, and a third tests it. You only step in for decisions.
- **They work as a team.** Give one task to several agents: one of them plans it and hands out the parts.
- **They keep going without you.** Schedule work overnight. When you're back, hive shows what happened.
- **Use the agents you already pay for:** Claude Code, Codex, Gemini, Qwen and more, side by side. You can mix them in one team.

## How it's different

| | hive | Grok Bot, OpenAI Dots | Agent frameworks | Multi-terminal tools |
|---|---|---|---|---|
| Runs on | your computer | their cloud | your code | your computer |
| Agents check each other | ✅ built in | not built in | if you build it | rarely |
| Agents work as a team | ✅ | Grok Bot only | if you build it | rarely |
| Mix Claude, Codex, Gemini… | ✅ | ❌ | ✅ | ✅ |
| Cost | your existing plans | their plan | API fees | your existing plans |
| Open source | ✅ | ❌ | mostly | varies |

More detail: [docs/COMPARISON.md](docs/COMPARISON.md)

## Install

You need [Node.js 22+](https://nodejs.org) and [Git](https://git-scm.com). Copy this page's address from the green **Code** button.

**Windows** (PowerShell):

```powershell
git clone <repo-url> hive
cd hive
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
```

**Linux:**

```bash
git clone <repo-url> hive && cd hive
npm install && npm run build && npm link
```

**Then:**

1. Sign in to your agents once: `claude`, `codex login` or `gemini`.
2. Open hive: double-click the icon, or type `hive`.
3. Press **Ctrl+K** → **Set up a team**.

## Learn more

- [Start here](docs/START-HERE.md): desktop, server and phone setup
- [Using hive](docs/USAGE.md): every feature and command
- [Screenshots](docs/SCREENSHOTS.md)
- [How it's built](docs/ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

MIT license.
