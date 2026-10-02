# Architecture

How hive is built, for anyone reading or changing the code. Start here, then `npm test`.

## The idea in one picture

```
 you ──▶ pane UI / CLI / TUI / phone ──▶ Hub ──▶ AgentSession ×N ──▶ vendor CLI (Claude Code, Codex, Gemini…)
                                          │            │                 via its official ACP adapter
                                          │            └──▶ hive MCP server (one per agent): hive_send, hive_bb_*, hive_diff…
                                          └── SQLite (mail, blackboard, jobs, groups)  ◀── Scheduler (loops, intervals, watchers)
```

- **Every agent is the vendor's own program.** hive starts it over the [Agent Client Protocol](https://agentclientprotocol.com), so your subscription, auth, sandbox and permission prompts are the vendor's. hive never re-implements an agent loop. API models such as Gemini, OpenRouter or Ollama run through a small built-in ACP agent (`src/api/agent.ts`).
- **Agents work together through tools, not prompts.** Each session gets an MCP server (`src/hive/server.ts`) with the same `hive_*` tools for every vendor: mail, groups, a shared blackboard, reading another agent's branch, and remembering facts.
- **The hub delivers mail and wakes agents.** It never makes an agent wait inside a turn. An agent sends, finishes and stops, and the hub wakes the recipient (`src/core/hub.ts`).
- **Everything is local.** Nothing listens on the network. The UI talks to its backend over stdio. Chat bridges and the phone app connect out or stay inside your tailnet.

## Source map

| folder | what lives there |
|---|---|
| `src/core/` | the engine: `session.ts` (one ACP agent: briefing, prompts, permissions), `hub.ts` (all agents, mail delivery, worktrees), `scheduler.ts` (jobs), `agents.ts` (how to launch each vendor), `roles.ts` (presets), `team.ts` (team broadcasts, improvement flow), `memory.ts` (memory and learning), `verdict.ts`, `skills.ts`, `budget.ts` and `ledger.ts` (spending guards, token stats), `worktree.ts`, `trust.ts` (outside content is data) |
| `src/hive/` | shared state and agent tools: `db.ts` (SQLite schema and queries), `server.ts` (the hive MCP server), `kanban.ts`, `media.ts`, `voice.ts`, `browser.ts` and `android.ts` (device panes), `twitch.ts` |
| `src/api/` | the built-in ACP agent for OpenAI-compatible APIs |
| `src/ui/` | desktop app: `electron-main.ts` (window plus relay), `backend.ts` (owns the Hub for the UI, speaks NDJSON), `protocol.ts` (every message type between them), `mux.ts` / `attach.ts` / `web.ts` (several clients, remote, phone) |
| `src/ui/renderer/` | React UI: `App.tsx` (shell), `Pane.tsx` (one agent), `Grid.tsx`, `layout.ts`, `AgentDialogs.tsx`, `Drawer.tsx` (Hive panel), `store.ts` (state built from events), `focus.ts` (which box gets your typing), `Voice.tsx`, `Code.tsx`, `Kanban.tsx`, `Links.tsx`, `Verdict.tsx` |
| `src/cli/` | the `hive` command |
| `src/tui/` | `hive tui`; `controller.ts` holds the logic so it can be tested without a terminal |
| `src/bridges/` | Discord and WhatsApp, outbound only and allowlisted |
| `src/mock/` | a scripted ACP agent the tests (and demos) use instead of real vendors |
| `skills/`, `templates/` | built-in skills and starter files |
| `scripts/` | installers (Windows, Linux server), icon generator |
| `test/` | one file per area; `npm test` runs them all with the mock agent, `test/ui.ts` drives the real Electron app |

Every source file opens with a comment saying what it is for. Read that first.

## Design rules (keep these)

1. Agents never block on replies inside a turn. Send, finish, stop; the hub wakes them.
2. Agent identity comes from the hub in the environment (`HIVE_AGENT`). The database lives outside the workspace (`src/core/home.ts`).
3. Each agent has a permission policy (`ask`, `allow-reads`, `allow-all`, `reject-all`) on top of the vendor's own sandbox.
4. One git worktree per coding agent (`hive/<name>`). Watchers and reviewers only read.
5. Localhost only. Keys and tokens come from environment variables, never files in the repo, and agents never see other services' keys.
6. Adding a vendor means adding one entry in `src/core/agents.ts`.
7. Node 22+, TypeScript, ES modules. No network calls in tests: fakes stand in for every outside service.

## Things learned the hard way

- **Auth status is pushed, not returned.** In `initialize`, `agentCapabilities._meta.authStatus` is only a marker. The identity arrives later as the `_auth/status_update` notification. `kind: "none"` means logged out; silence means unknown.
- **JSON-RPC errors hide the detail in `data`.** `errorText()` in `session.ts` surfaces it; usage-limit detection needs it.
- `session/load` replays history as `session/update` notifications, and they can arrive after the response.
- better-sqlite3 is built for system Node, so the Electron app runs the hub in a Node child process (`backend.ts`) rather than in Electron itself.
- On POSIX, `kill()` reaches only the direct child, so agents are spawned in their own process group and killed as a group. On Windows hive uses `taskkill /T /F`.

## Commands

```bash
npm install
npm test                  # all suites, mock agents, ~3 min
npm run test:ui           # the Electron app end to end (Linux: xvfb-run -a npm run test:ui)
npm run typecheck
npm run dev -- doctor     # run the CLI from source
npm run dev -- ui --cwd ~/code/app
```

Environment: `HIVE_HOME` moves all hive state; `HIVE_NODE` points the app at a Node binary; `HIVE_HOTKEY` changes the global focus key. Provider keys are listed in [MODELS.md](MODELS.md).
