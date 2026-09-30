# hive

Local multi-agent harness. One process, any number of coding agents (Claude Code, Codex, Qwen, OpenCode, Gemini, …), all driven through the [Agent Client Protocol](https://agentclientprotocol.com), all able to message each other, with loops, schedules and file watchers that run 24/7.

Design goals, in order:

1. **Your subscriptions keep working.** Every agent is the vendor's own binary behind its official ACP adapter. Auth, sandboxing and permission prompts are the vendor's; hive never re-implements the agent loop.
2. **Agents talk to each other** through a `hive` MCP server injected into every session. Same tools for every vendor, no per-CLI hacks.
3. **Runs 24/7 on one machine.** Nothing listens on the network. No Discord, no WhatsApp.
4. **Many agents on one screen.** A pane grid for a 4K monitor, voice-friendly input routing.

## Quick start

```
npm install
npm test                         # mock-agent end-to-end suites (no vendor login needed)
npm run dev -- doctor            # installed? speaks ACP? logged in?
npm run ui                       # the pane UI (Electron)
npm run dev -- chat claude --cwd ~/code/myproject
```

## CLI

```
hive run <agent> "prompt"                  one prompt, wait for replies to settle, exit
hive chat <agent>                          interactive; resumes the last session (--fresh for new)
hive agents                                who's in the hive, status, unread mail
hive doctor [agent...] [--quick]           probes each adapter with ACP initialize + auth push

hive loop  <agent> --times 5 "prompt"      back-to-back runs, fresh session each, shared notes file
hive loop  <agent> --for 8h  "prompt"      … until the time is up
hive every <agent> 10m "prompt"            on an interval
hive watch <agent> <path> --min-lines 50 "prompt"   when enough lines change (untracked files count)
hive once  <agent> --in 20m "prompt"
hive start <agent> --as security|scout|bughunter    a role preset's default job
hive jobs [--all] · hive job stop|start|runs|rm <id>
hive serve                                 run every queued job + mail delivery (use with --detach)

hive worktrees                             agent branches: ahead/behind, diffstat, uncommitted
hive merge <name>                          merge hive/<name> into the main checkout (--no-ff)
hive worktree rm <name> [--force]
```

Common options: `--name N --cwd DIR --role R --policy ask|allow-reads|allow-all|reject-all --as <preset> --worktree --db PATH --quiet`.

Job commands run in the foreground until the job ends (Ctrl-C stops it). `--detach` only queues the job; `hive serve` (or the UI) runs it.

In `chat`: type while the agent works (prompts queue), Ctrl-C cancels a turn, Ctrl-C when idle quits, `/new` fresh session, `/model <id>`, `/config`, `/status`.

## Pane UI

`npm run ui` builds and starts the Electron app in the current folder (`--cwd`, `--db` to override).

- Grid of panes, N per row, drag the gaps to resize, Ctrl+M maximizes. Layout persists in `.hive/ui.json`, panes come back (and their ACP sessions resume) on restart.
- Sidebar: every agent with model/effort, idle time, ctx %, unread mail, status note; worktrees with a merge button; jobs with stop.
- Each pane: markdown replies, collapsible thinking, tool cards with diffs, plan checklist, permission prompts and agent questions answered inline, model/effort selectors, ctx meter, ⏱ to schedule a loop / interval / watch job on that agent.
- Input routing for voice typing (Handy): hover a pane to focus its input (toggle in the top bar), Ctrl+1..9 jump, Ctrl+Tab cycle, Ctrl+Alt+H (global) brings hive forward on the last active pane. Enter sends (queues while busy), Esc cancels, ↑ recalls.
- Broadcast box: send one prompt to the ticked panes, or all.

Architecture: Electron main is a relay; the hub runs in a system-Node child process (`src/ui/backend.ts`) that speaks NDJSON over stdio, so native modules need no Electron rebuild and no socket is ever opened. Renderer is sandboxed with a strict CSP.

## Role presets

`--as <preset>` on the CLI or the Preset field in the UI:

| preset | policy | worktree | default job |
|---|---|---|---|
| coder | ask | yes | — |
| reviewer | allow-reads | no | — |
| security | allow-reads | no | watch ≥50 changed lines |
| scout | allow-reads | no | every 10m |
| bughunter | allow-all | yes | loop 5× |

## Scheduler

Jobs live in the SQLite `jobs` table; runs in `job_runs` (stop reason, usage, session id, error).

- **Fresh session per run** plus `<cwd>/.hive/notes/job-<id>.md`, which the prompt tells the agent to read first and update before finishing (the Ralph-loop pattern: iterations hand over through the notes file, not one ever-growing context).
- **watch** snapshots the tree into a shadow git index under `.hive/watch/` and counts `git diff --numstat` lines between snapshots, so new untracked files count and your own index is never touched. `.git`, `node_modules`, `.hive` are ignored; `.gitignore` is honoured. The prompt lists what changed.
- Jobs are claimed with a lease, so `hive serve`, the UI and a foreground `hive loop` never run the same job twice. Stopping a job cancels its in-flight turn. Five failures in a row end a job as `failed`.

## Worktrees

`--worktree` (or the coder/bughunter presets) runs an agent in `<repo>/.hive/worktrees/<name>` on branch `hive/<name>`. `.hive/` ignores itself, so nothing shows up in your `git status`. `hive merge <name>` does a `--no-ff` merge into the main checkout, refusing if it has uncommitted changes and aborting cleanly on conflict.

## How a message flows

```
alice (claude)  ── hive_send(to: bob) ──▶  sqlite messages
                                              │
hub delivery loop (1.5 s): bob idle && unread>0
                                              ▼
bob (codex)  ◀── prompt: "You have 1 unread hive message: 1 from alice ("review auth")…"
bob ── hive_inbox ── hive_send(to: alice, thread) ──▶ sqlite
hub wakes alice the same way.
```

Agents never block waiting for replies inside a turn; the briefing tells them so. Identity is set by the hub through env (`HIVE_AGENT`), not by the agent, so an agent can't impersonate another.

## Permission policy

Per agent: `ask` (UI pane or terminal), `allow-reads` (auto-approve read/search/fetch, ask for the rest), `allow-all`, `reject-all`. The vendor's own sandbox still applies underneath.

## Vendors

| id | adapter | auth |
|---|---|---|
| claude | `@agentclientprotocol/claude-agent-acp` | `claude login` (Max) or `ANTHROPIC_API_KEY` |
| codex | `@agentclientprotocol/codex-acp` | `codex login` (ChatGPT) or `OPENAI_API_KEY` |
| qwen | `qwen --acp` | `QWEN_BASE_URL` → your Ollama/vLLM, `QWEN_MODEL` |
| opencode | `opencode acp` | any provider (DeepSeek, GLM, OpenRouter, local) via opencode.json |
| gemini | `gemini --experimental-acp` | google login |
| mock | built-in | none |

`hive doctor` spawns each adapter, sends `initialize`, and waits for its `_auth/status_update` push, so it reports "not logged in" vs the account actually in use.

## Layout

```
src/core/agents.ts     which subprocess to spawn per vendor (add a vendor = add an entry); Windows quoting
src/core/session.ts    one ACP agent: spawn, inject hive MCP, route updates, resume/load, permissions, elicitation
src/core/hub.ts        many sessions + delivery loop that wakes idle agents with unread mail
src/core/scheduler.ts  loop / interval / watch / once jobs, leases, notes files
src/core/watch.ts      changed-line counting (chokidar + shadow git index)
src/core/worktree.ts   git worktree per agent, status, merge
src/core/roles.ts      role presets
src/core/doctor.ts     adapter probe
src/hive/db.ts         SQLite: agents, messages, blackboard, events, jobs, job_runs
src/hive/server.ts     the MCP server each agent gets (hive_send / hive_inbox / hive_bb_* / hive_status / hive_agents)
src/mock/agent.ts      scripted ACP agent for tests; really calls the hive tools
src/cli/index.ts       the CLI
src/ui/                Electron main, preload, NDJSON backend, React renderer
test/                  e2e, session, scheduler, worktree, backend, unit; ui.ts drives Electron (npm run test:ui)
```
