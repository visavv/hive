# HANDOFF — hive, phases 1–4 done + two review loops

Read this first, then README.md, then `npm test`.

## 0. What this is

A local multi-agent coding harness. Claude Code, Codex, local Qwen and API-key models (via OpenCode) run side by side, message each other through an injected `hive` MCP server, and run scheduled / looping / file- or branch-triggered jobs 24/7. Every agent is the vendor's own binary behind its official ACP adapter, so subscriptions keep working; hive never reimplements the agent loop. No network listeners, no chat gateways.

Owner: solo developer on Windows, 4K monitor, Handy speech-to-text, Proxmox/Dell T550 for local models. Prior-art survey was done in phase 1 (Munder Difflin, Parallel Code, Gas Town, Oh My OpenAgent) — don't redo it.

## 1. State

All of the original plan is implemented and tested with the mock agent:

| area | where | notes |
|---|---|---|
| ACP session | `src/core/session.ts` | own `session/update` routing by sessionId; new / resume / load (replay suppressed) / fresh sessions on one process; cancel via kept `ClientContext`; cancel also answers pending asks as cancelled; elicitation; permission policy never falls back to allow; wake backoff + budget; `runOnce({fresh})` claims the agent atomically |
| hub | `src/core/hub.ts` | agent leases in SQLite (one process per agent name), resume by stored session id (same vendor + cwd), worktree option, event pruning |
| scheduler | `src/core/scheduler.ts` | loop / interval / watch (folder or `@branches`) / once; job leases; usage-limit pause until reset; failure backoff; notes file per job; `job_runs` with summary |
| watch | `src/core/watch.ts` | chokidar + shadow git index (untracked files count, user index untouched); branch watch over `refs/heads/hive/*` |
| worktrees | `src/core/worktree.ts` | per agent, outside the repo in the per-user project dir; status / merge (`--no-ff`, refuses dirty checkout, aborts on conflict) / remove |
| state dir | `src/core/home.ts` | `$HIVE_HOME` or `%LOCALAPPDATA%\hive` etc.; `projects/<repo>-<hash>/{hive.db,ui.json,watch/,worktrees/}` — the db is not in the workspace |
| roles | `src/core/roles.ts` | coder, reviewer, security, scout, bughunter |
| report | `src/core/report.ts` | "since you left": runs, summaries, tokens, commits on agent branches, blackboard, owner mail |
| doctor | `src/core/doctor.ts` | `initialize` probe + waits for `_auth/status_update` |
| MCP tools | `src/hive/server.ts` | hive_agents / send (incl. `owner`, thread budget) / inbox / thread / bb_get,set,list,delete / status / diff / log |
| CLI | `src/cli/index.ts` | run chat agents doctor ui · loop every watch once start jobs job serve · report inbox send bb · worktrees merge worktree |
| UI | `src/ui/` | Electron main (relay, respawn, CSP, file: blocking) · Node backend (`backend.ts`, NDJSON on stdio) · React renderer (grid, sidebar, drawer) |

Tests (`npm test`, ~2 min): e2e, session, scheduler, unit, backend, worktree. `npm run test:ui` drives the real Electron app with Playwright (needs a display; on Linux `xvfb-run -a`).

Adapters are pinned in package.json (`claude-agent-acp` 0.84.0, `codex-acp` 2.0.1) and run with `node` from node_modules (no npx, no shell).

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

## 4. Not verified here (no vendor logins in the build container)

- **An actual authenticated turn through claude/codex.** First thing on a machine with logins: `npm run dev -- doctor` (should show your account), then `npm run dev -- chat claude --cwd <repo>`, then `npm run ui`. Watch for: config option shapes (model/effort selectors), tool_call content shapes (diffs), `usage_update` for ctx %, the usage-limit error text (`isRateLimit`/`resetTime` in scheduler.ts are regex guesses — adjust to the real message).
- Windows specifics: spawn/quoting (`spawnSpec`, `winQuote`), `taskkill`, `%LOCALAPPDATA%` paths, notifications (`setAppUserModelId`), global hotkey.

## 5. Open items / next ideas

- Close-to-tray + start at login; let the backend outlive the window (attach over a named pipe `\\.\pipe\hive-<user>` — local only).
- Render `hive_*` tool results (JSON) as tables in panes.
- Clickable job rows in the sidebar → run history + summaries (data exists: `job_runs`).
- Subagent sessions from claude-agent-acp (`sessionCapabilities.subagents`) as nested panes.
- Terminal capability (`terminal/*`) and a raw-terminal fallback pane (needs node-pty built for Electron).
- Cost history from `~/.claude/projects/*/*.jsonl` (low priority per owner).

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
