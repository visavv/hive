# hive vs Odysseus

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
