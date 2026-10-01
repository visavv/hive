# HANDOFF: hive (state as of 2026-10-01)

Read this first, then README.md, then run `npm test`.

## 0. What this is

A local multi-agent harness. Agents run side by side and message each other through an injected `hive` MCP server:
- Claude Code, Codex, Gemini CLI, Qwen and OpenCode through their vendors' ACP adapters, so subscriptions keep working;
- API models through a built-in ACP agent.

They run scheduled, looping or triggered jobs. hive never reimplements a vendor's agent loop. There's no network listener; chat bridges connect outbound only.

Owner: solo developer. Windows desktop (4K plus vertical 9:16 monitors), a Fedora laptop, a Proxmox/Ubuntu server, Handy speech-to-text. Also YouTube creator tools.

## 1. State

| area | where | notes |
|---|---|---|
| ACP session / hub / scheduler / worktrees | `src/core/{session,hub,scheduler,watch,worktree}.ts` | as before: leases, resume, fresh sessions, wake budget/backoff, usage-limit pause, branch/blackboard triggers, cooldowns |
| API agent | `src/api/agent.ts`, `src/core/agents.ts` | OpenAI-compatible streaming + tool calls (hive MCP + read/list/write files, folder-confined via realpath, no shell); built-ins gemini-api, openrouter, openai-api, meta-llama, ollama; `agents.json` + `hive providers add` |
| usage & budgets | `src/core/budget.ts` | usage_log, Claude rate-limit windows, daily caps (default 2M/day for API providers' automatic work), reserve %, max concurrent, media cap, pause |
| media | `src/hive/media.ts` | ElevenLabs TTS, image gen/edit; agents queue via the db and the hub makes the call (keys stay in the hive process) |
| links / layer | `src/hive/db.ts` (route), `src/ui/renderer/Links.tsx` | groups, review mode (held mail: release/edit/drop), hourly caps, "only linked" scope; mail from unlinked agents to allow-all agents is held by default |
| trust | `src/core/trust.ts` | peer mail, board entries, diffs and file contents are wrapped as untrusted data; trust policy in every briefing and wake-up |
| verdict | `src/core/verdict.ts`, `src/ui/renderer/Verdict.tsx` | N contenders (own worktrees) → blind judge → apply |
| skills / YouTube | `src/core/skills.ts`, `src/core/youtube.ts`, `skills/*.md` | params, project/user/built-in; only built-in skills may run allow-all; YouTube links become transcripts (yt-dlp or player API) |
| bridges | `src/bridges/*` | Discord (discord.js), WhatsApp (Baileys, on demand); allowlist, outbound only |
| UI | `src/ui/` | Electron relay + Node backend + React renderer. Pane grid with vertical layout; ready mark + chime; Usage, Accounts, Inbox (held mail); long-prompt editor; verdict window; SVG icons (`Icons.tsx`) |
| platform | `scripts/install-windows.ps1`, `hive desktop`, CI | Windows / Ubuntu / Fedora 42 in CI, including the Electron UI test and the Windows installer |

Tests: `npm test` runs 17 suites (mock agent, fake HTTP APIs, fake YouTube, fake chat clients). `npm run test:ui` drives the real Electron app; it needs a display (`xvfb-run -a` on Linux).

## 2. Facts learned the hard way

- **Auth status is pushed, not returned.** `initialize` → `agentCapabilities._meta.authStatus: {}` is only a capability marker. The identity arrives as notification `_auth/status_update` `{authStatus: {kind, label, detail?}}`; `kind: "none"` = logged out; silence = unknown. (The phase-1 handoff said otherwise.)
- **JSON-RPC errors hide the detail in `data`.** The SDK maps thrown errors to `-32603 "Internal error"` with `data.details`; `errorText()` in session.ts surfaces it (needed to recognize usage limits).
- `ActiveSession` can only wrap `session/new`; for load/resume we route updates ourselves. `session/load` replays history as `session/update` and those can arrive after the response.
- Real adapters exit on stdin EOF (claude-agent-acp ~15 ms, codex-acp ~2 s).
- better-sqlite3 is built for system Node's ABI, so the Electron UI runs the hub in a Node child process instead of Electron main.
- On POSIX `proc.kill()` only reaches the direct child: agents are spawned `detached` (own process group) and killed as a group; on Windows `taskkill /T /F`.

## 3. Design rules (keep these)

1. Agents never block on replies inside a turn. Send, finish, stop; the hub wakes them.
2. Identity via env from the hub (`HIVE_AGENT`); the db lives outside the workspace.
3. Permission policy per agent, vendor sandbox underneath. Unattended job agents decline unanswered prompts after 15 min.
4. One worktree per coding agent; watchers read-only.
5. Localhost only. No listeners except the UI's own stdio/IPC.
6. Vendor added = one entry in `agents.ts`.
7. Node/TypeScript ESM, Node ≥22.

## 4. Not verified here (needs the owner's machines and accounts)

- **Authenticated turns** with real Claude Code / Codex logins, the real `_claude/rateLimit` payloads, and real usage-limit error text (`isRateLimit` / `resetTime` regexes).
- **Real API keys**: Gemini, OpenRouter, Meta Llama API (`https://api.llama.com/compat/v1`, an assumption; override with `LLAMA_API_BASE`), ElevenLabs, images.
- **Real YouTube** caption fetching (the player API path can break when YouTube changes; yt-dlp is the robust path).
- **Real Discord/WhatsApp accounts.** The rule is no real messages from tests.
- **A real Windows desktop** (scaling, vertical monitor, notifications, chime, hotkey) and a **real Fedora Wayland session** (hotkey portal).

## 5. Open items / next ideas (see audit/ROADMAP.md)

- `.worktreeinclude`: copy `.env` etc. into agent worktrees.
- Chain on "agent finished" (coder done → tester → reviewer).
- Bridge commands for held mail and verdicts (approve or release from Discord).
- Per-pane mute; "ready" pushed to chat bridges; prompt-engineer "use this prompt" round trip.
- USD estimates for API providers; GitHub-event triggers by polling (no listener).
- Close-to-tray / start at login; terminal capability panes.

## 6. Commands

```
npm install
npm test                      # mock suites
npm run test:ui               # Electron e2e (display needed)
npm run typecheck
npm run dev -- doctor
npm run dev -- ui --cwd ~/code/x
npm run dev -- chat claude --as coder --cwd ~/code/x
npm run dev -- start claude --as security --cwd ~/code/x
npm run dev -- loop claude --as bughunter --for 8h --cwd ~/code/x "hunt bugs in src/"
npm run dev -- report --since 12h
```

Env for local Qwen: `QWEN_BASE_URL=http://<t550>:11434/v1 QWEN_MODEL=qwen3-coder QWEN_API_KEY=ollama`. `HIVE_HOME` moves all hive state; `HIVE_HOTKEY` changes the global focus hotkey; `HIVE_NODE` points the UI at a node binary; `HIVE_MAX_THREAD` caps agent back-and-forth per thread.
