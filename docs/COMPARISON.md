# hive compared with similar tools

Odysseus: https://github.com/odysseus-dev/odysseus. Reviewed on 2026-10-01 from a shallow clone of `main` (commit e303582) plus its README and THREAT_MODEL. I read the code and docs; I didn't install or run it.

## What each one is

| | **hive** (this repo) | **Odysseus** |
|---|---|---|
| In one line | Runs your existing coding agents (Claude Code, Codex, Gemini CLI, Qwen, OpenCode, API models) side by side and lets them work together | A self-hosted AI workspace: chat, agents, deep research, documents, email, notes, calendar, model serving |
| Main job | Coding and automation: several agents, worktrees, reviews, jobs, skills | Personal assistant and knowledge work, one agent loop with many tools |
| Stack | Node/TypeScript, Electron desktop UI + CLI, SQLite | Python/FastAPI web app (port 7000), SQLite or Postgres, ChromaDB, Docker |
| Runs as | Desktop app or `hive serve`. **Never opens a network port.** | A web server you open in the browser (plus Mac/Windows wrappers); meant for a private network |
| Users | You alone | Multi-user, with admin and non-admin roles, 2FA and API tokens |
| License | (this repo) | AGPL-3.0 |
| Maturity | Young, personal | Large and active (≈88k stars, ~2k commits, 1.1k open issues) |

## How models and subscriptions are used

- **hive** drives each vendor's own agent through its official ACP adapter. Your Claude Pro/Max or ChatGPT plan works because the vendor's CLI does the work with its own login, sandbox and tool set. hive never sees or stores those tokens. API models (Gemini, OpenRouter/Meta Llama, OpenAI, Ollama, anything OpenAI-compatible) run through a small built-in agent.
- **Odysseus** runs its own agent loop and calls model endpoints directly. For ChatGPT it runs a device-code sign-in in its UI and **stores the subscription's access and refresh tokens in its own database** (`routes/chatgpt_subscription_routes.py`); it does the same for GitHub Copilot. Its Claude Code "integration" works the other way round: Claude Code calls Odysseus through a skill and a scoped API token.
- What that means for you: Odysseus gives one UI for every model, including subscription models, inside its own tools. hive gives each vendor's full coding agent (Claude Code's edits, shell, subagents; Codex's sandbox) and makes them cooperate. Reusing a subscription token outside the vendor's own client is a gray area under the vendor's terms; hive avoids it on purpose.

## Multi-agent work

- **hive**: built for it. Several agents at once, each with a role, a permission policy and its own git worktree. Mail, groups with review mode and hourly caps (drag panes together), a blackboard, follow-ups, triggers (new code, time, blackboard entries), recipes such as coder + reviewer, and per-provider budgets.
- **Odysseus**: one agent per chat, plus scheduled agent tasks, multi-step deep research, and **Compare** (blind side-by-side model answers, then a combined answer). There is no team of agents messaging each other.

## Safety

- **hive**: agents run inside the vendor's sandbox and permission prompts, plus hive's own policies (ask, allow-reads, allow-all, reject-all). There is no listener, so nothing on the network can reach it. Media and API keys stay in the hive process. Spending guards stop automatic work. Open items from the audit: repo skills can request allow-all, symlinks can escape folder confinement, and peer mail can drive an allow-all agent.
- **Odysseus**: real authentication (bcrypt, sessions, TOTP), role-based tool blocking, a strict CSP, SSRF tests. It wraps untrusted content (web pages, emails, memories, skill text) in a "this is data, not instructions" message. Its own threat model lists **no shell/filesystem sandbox** as a known gap: the agent's bash and file tools run as the app user.

## Features Odysseus has that hive doesn't (and whether they fit)

| Odysseus feature | Fit for you | Suggestion |
|---|---|---|
| Untrusted-content wrapping (`src/prompt_security.py`) | **High.** It's the fix for audit finding SEC-003 | Wrap mail from other agents (and any fetched text) as untrusted data in wake-up prompts. Small change. |
| YouTube transcripts (`services/youtube`, youtube-transcript-api) | **High** for your channel | Let the yt-* skills take a YouTube URL as well as a transcript file. Small. |
| Compare: blind side-by-side + synthesis | **High** for titles, hooks and prompts | `hive skill run yt-titles --compare claude,gemini-api,openrouter`: run on several models, show results unlabeled, you pick or merge. Medium. |
| Semantic memory / RAG (ChromaDB) | Medium | The blackboard covers shared facts. Searchable long-term memory could come later; it adds a vector DB. |
| Cookbook (hardware-aware local models) | Medium for the T550 | Suggest Ollama models that fit the T550's GPU or RAM. Nice to have. |
| Deep research reports | Low to medium | An agent with web access can already do this. A "research" recipe could package it. |
| Email, calendar, CalDAV, notes, documents | Low | Different product; adding them would bloat hive. |
| Multi-user, 2FA | Not applicable | hive is single-user and has no listener on purpose. |
| Phone companion (pairing) | Covered differently | hive's Discord/WhatsApp bridges are outbound-only, so there's no port to expose. |

## Bottom line

They overlap less than it looks. Odysseus is an all-in-one personal AI workspace that you host. hive orchestrates the coding agents you already pay for, with teamwork between them and tight local control. For your workflow (coding automations plus YouTube tools on Windows and Fedora), hive is the better base. The Odysseus ideas worth taking are untrusted-content wrapping, YouTube URL transcripts, and blind multi-model comparison.

---

# The wider field (research 2026-10-01)

Yes, there are comparable apps. Parallel coding agents in git worktrees became a crowded category in 2026. The table comes from official READMEs, docs and product pages; facts that only third-party articles mention are flagged as such. These are documentation reviews, not hands-on tests.

| Tool | Type | Platforms | Parallel agents + worktrees | Agents (subscriptions?) | Agents talk / orchestration | Scheduling / triggers | License |
|---|---|---|---|---|---|---|---|
| **Maestro** (runmaestro.ai) | Desktop (Electron) | Win, macOS, Linux | ✓ worktree "sub-agents" | Claude Code, Codex, OpenCode, Factory Droid, Copilot CLI, Qwen, more. CLIs, multiple accounts | ✓ Group Chat with a moderator AI; @mentions | ✓ "Cue": interval, scheduled, file changed, agent completed (chaining), GitHub PR/issue | AGPL-3.0 |
| **Agent Deck** | TUI + local web dashboard | macOS, Linux (Windows via WSL) | ✓ worktree per session, Docker option | Claude Code, Gemini, Codex, OpenCode, Copilot, Cursor and more | ✓ "Conductors" (supervisor agents) | Watchers (GitHub, webhooks); Telegram/Slack bridges; budgets | MIT |
| **Superset** | Desktop "agentic IDE" | macOS (Linux experimental; no Windows) | ✓ | 25+ CLI agents, your own subscriptions | Shared coordination (vague) | ✓ scheduled agents that open PRs | Elastic 2.0; paid Pro |
| **Conductor** | Desktop | macOS only | ✓ | Claude Code, Codex, Cursor, OpenCode | — | API (Pro) | Proprietary; free + paid |
| **Nimbalyst** (formerly Crystal) | Desktop + iOS | Win, macOS, Linux | ✓ | Claude Code, Codex; others via ACP (alpha) | Kanban of sessions | — | MIT |
| **Vibe Kanban** | Local web UI | via Node | ✓ | Claude Code, Codex, Gemini, Copilot, Amp, Cursor, OpenCode, Qwen | Kanban tasks, MCP | — | Apache-2.0 (repo says it's sunsetting) |
| **Parallel Code** | Desktop | macOS, Linux | ✓ | Claude Code, Codex, Gemini, Copilot | Head-to-head comparison only | — | MIT |
| **Jean** (coolLabs) | Desktop (Tauri) | macOS (Win/Linux partial) | ✓ | Claude, Codex, Cursor, OpenCode, more | AI review / merge-conflict helpers | — | Apache-2.0 |
| **T3 Code** | Desktop + web + mobile | Win, macOS, Linux | Multi-agent control (worktrees not confirmed) | Codex, Claude Code, Cursor, OpenCode, more. Your subscriptions, multiple accounts | — | — | MIT |
| **Claude Squad** / **CCManager** | TUI | Unix (CCManager also Windows) | ✓ | Claude Code, Codex, Gemini, more | — | hooks / auto-approve | AGPL-3.0 / MIT |
| **Zed** (parallel agents + ACP) | IDE | Win, macOS, Linux | ✓ thread per worktree (optional) | Its own agent + ACP agents (Claude, Codex, Gemini, OpenCode, Copilot…) | — | worktree hooks | open source |
| **Toad** | TUI (ACP client) | Linux, macOS (Windows via WSL) | several agents; no worktrees | any ACP agent | — | — | AGPL-3.0 |
| **OpenHands Agent Canvas** | Local web UI + SDK | anywhere | multiple sessions | Claude Code, Codex, Gemini via ACP; subscriptions or keys | SDK orchestration | ✓ automations | MIT (cloud paid) |
| **Cursor 3** | IDE + cloud | Win, macOS, Linux | ✓ local, worktree, cloud agents; best-of-n | Cursor's models (not vendor CLIs) | async subagents (third-party sources only) | ✓ cron, GitHub, Slack, Linear, webhooks (cloud) | proprietary, paid |
| **Claude Code itself** | CLI | Win, macOS, Linux | ✓ agent view, background sessions in worktrees | Claude only | ✓ agent teams, cross-session messaging with hold/approve | ✓ /loop; channels (Telegram/Discord/iMessage) | proprietary |
| **OpenAI Codex app** | Desktop | Win, macOS, Linux | ✓ worktrees, parallel threads | OpenAI only | — | ✓ automations | proprietary |

Also checked: herdr (agent-aware terminal multiplexer), cmux (macOS terminal), Sculptor (containers, no Windows yet), Xum (formerly coder/mux, API models), Warp Oz (enterprise cloud), Happy (phone remote for Claude/Codex), container-use, Uzi, Goose (recipes + scheduler), Kiro, Amp, Google Antigravity, VS Code agent harnesses / GitHub Agent HQ. Terragon has shut down; Omnara pivoted.

## Closest matches and what they do better

- **Maestro** is the closest overall: a desktop app on Windows and Linux with multiple vendors, worktrees, a group chat with a moderator, and rich triggers (agent-completed chaining, GitHub events). It also offers phone control through a built-in web server and tunnel, SSH remotes, and playbooks. It has no Gemini CLI support and doesn't run API models through one protocol.
- **Agent Deck**: supervisor "conductors", two-way Telegram/Slack, an MCP attach manager, session forking, sparse worktrees, budgets. Windows only through WSL.
- **Zed** is the closest on protocol: ACP agents from every vendor side by side, plus a full editor and MCP forwarding. It has no agent-to-agent messaging and no scheduling.
- **Claude Code itself** now has agent teams, cross-session messaging with approval, /loop and chat channels. That covers much of hive's teamwork, but for Claude only.

## What still looks distinctive about hive

- Mail, groups and a shared blackboard **across vendors** (Claude Code + Codex + Gemini + API models talking to each other). Others have this only within one vendor (Claude teams) or through a moderator/supervisor (Maestro, Agent Deck).
- **Drag panes together** to form a group, with an owner **review-each-message** layer. Only Claude Code's cross-session messaging has a similar approve step, and only for Claude.
- **No network listener at all.** Maestro, Agent Deck, Jean, Vibe Kanban, OpenHands, Xum and T3 Code all open a local or remote server for their UI or phone access.
- Vertical 9:16 layout, an outbound WhatsApp bridge, blackboard triggers, YouTube/creator skills.
- Not unique: worktrees, multiple vendors, budgets (Agent Deck), recipes/playbooks (Goose, Maestro), using subscriptions instead of keys (T3 Code, OpenHands, Superset).

## Ideas worth borrowing from the field

| Idea | Seen in | Fit |
|---|---|---|
| Chain on "agent finished" (fan-out / fan-in) | Maestro Cue | High: a natural extension of watch jobs (e.g. coder done → tester → reviewer) |
| GitHub triggers (PR opened, label, issue) | Maestro, Cursor, Warp | Medium: needs polling the GitHub API (no webhooks, since there's no listener) |
| Copy `.env` and other untracked files into new worktrees | CCManager `.worktreeinclude` | High: worktrees often fail without `.env` |
| Best-of-n / head-to-head on one task | Cursor, Parallel Code, Odysseus Compare | High for titles and prompts |
| Supervisor agent that keeps asking until a question is answered | Maestro moderator, Agent Deck conductors | Medium: the review layer and recipes cover part of it |
| Session fork with inherited context | Agent Deck | Medium |
| Phone control | Maestro, T3 Code, Happy | Covered by the outbound Discord/WhatsApp bridges, without opening a port |
