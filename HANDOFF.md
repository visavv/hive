# HANDOFF — hive, phase 1 → phase 2+

Read this first, then README.md, then `npm test`.

## 0. What this is

A local multi-agent coding harness. Goal: run Claude Code, Codex, local Qwen, and API-key models (DeepSeek/GLM/etc. via OpenCode) side by side in one UI, with the agents able to message each other, run scheduled/looping/file-triggered jobs 24/7, and stay as secure as the vendor CLIs themselves (no network listeners, no chat-platform gateways). Subscriptions must keep working, so every agent is the vendor's own binary behind its official ACP adapter; hive never reimplements the agent loop.

Owner is a solo developer on Windows (Handy speech-to-text on the desktop; a Proxmox/Dell T550 homelab that will host Ollama/vLLM for the Qwen agent).

Prior-art survey (already done, don't redo): Munder Difflin (closest; PTY-driven, gimmicky UI, borrowed its hive design), Parallel Code (best worktree UX, no messaging, no Windows), Gas Town (tmux, hierarchical, expensive), Oh My OpenAgent (inside OpenCode; Anthropic blocks Claude subs there). Decision: build thin, on ACP.

## 1. State of the repo

```
src/core/agents.ts     AgentDef registry: claude, codex, qwen, opencode, gemini, mock. ${VAR} env expansion.
src/core/session.ts    AgentSession: spawn adapter → ACP initialize → session/new with hive MCP injected →
                       prompt loop over session.nextUpdate() → typed SessionEvent stream → permission policy →
                       mail-as-prompt delivery when idle. Briefing text prepended to first prompt.
src/core/hub.ts        Hub: Map<name, AgentSession>, 1.5 s poke loop wakes idle agents with unread mail, settle().
src/hive/db.ts         better-sqlite3 (WAL). Tables: agents, messages, blackboard, events, jobs (jobs unused yet).
src/hive/server.ts     MCP stdio server. Identity from env HIVE_DB + HIVE_AGENT (set by hub, not agent).
                       Tools: hive_agents, hive_send, hive_inbox, hive_thread, hive_bb_set/get/list, hive_status.
src/mock/agent.ts      Scripted ACP agent. Connects to MCP servers it's handed, really calls hive tools.
                       Prompt DSL: "send <name|*>: <text>", "bb k=v", "agents?", "edit" (asks permission).
src/cli/index.ts       hive run|chat|agents|doctor
test/e2e.ts            8 assertions, all passing: mail round-trip via hub wake-ups, both permission policies,
                       blackboard, usage on turn_end.
```

Verified live package versions (npm, 2026-09-30): `@agentclientprotocol/sdk` 1.5.1, `@agentclientprotocol/claude-agent-acp` 0.84.0, `@agentclientprotocol/codex-acp` 2.0.1, `@modelcontextprotocol/sdk` 1.31.0, `@qwen-code/qwen-code` 0.24.7.

`claude-agent-acp` answers `initialize` with: `loadSession: true`, `sessionCapabilities: {list, resume, fork, close, delete, subagents}`, `promptCapabilities: {image, embeddedContext}`, `mcpCapabilities: {http, sse}`, `_meta.steering.supported: true`, `_meta.claudeCode.promptQueueing: true`. Use these.

Not verified (no vendor auth in the build container): an actual prompt turn through claude/codex. **First task on a machine with logins:** `npm run dev -- chat claude --policy allow-reads --cwd <some repo>` and fix whatever breaks.

## 2. ACP facts the code relies on

- JSON-RPC over stdio, NDJSON. SDK fluent API: `acp.client({name}).onRequest(acp.methods.client.session.requestPermission, …).connectWith(stream, async ctx => …)`.
- `ctx.buildSession(cwd).withMcpServer({name, command, args, env:[{name,value}]}).start()` → `ActiveSession` with `.prompt(text)` and `.nextUpdate()` yielding `{kind:"session_update", update}` or `{kind:"stop", stopReason, response}`.
- `SessionUpdate.sessionUpdate` discriminators: `user_message_chunk, agent_message_chunk, agent_thought_chunk, tool_call, tool_call_update, plan, plan_update, plan_removed, available_commands_update, current_mode_update, config_option_update, session_info_update, usage_update, notice, compaction_update, compaction_summary_chunk`.
- `PromptResponse.usage` (unstable): `{totalTokens, inputTokens, outputTokens, thoughtTokens?}`.
- `session/request_permission` → options with `kind ∈ allow_once|allow_always|reject_once|reject_always`; respond `{outcome:{outcome:"selected", optionId}}`.
- `session/cancel` is a notification client→agent.
- All paths absolute. `McpServerStdio.env` is an array of `{name, value}`, not an object.
- Hive MCP is launched in dev as `node <tsx cli> src/hive/server.ts`, in prod as `node dist/hive/server.js` (`isTs` check in session.ts).

## 3. Design rules (keep these)

1. **Agents never block on replies inside a turn.** Send, finish, stop. Hub wakes them when mail arrives. This preserves each vendor's turn model and works for agents that are asleep.
2. **Identity via env from the hub.** Agents can't choose `HIVE_AGENT`.
3. **Permission policy per agent**, vendor sandbox still underneath. `ask` for interactive coders, `allow-reads` for watchers/reviewers, `allow-all` only for trusted loops in a worktree.
4. **One worktree per coding agent.** Watchers get read-only on the main checkout.
5. **Localhost only.** No HTTP listeners except the UI's own IPC. No Discord/WhatsApp.
6. **Vendor added = one entry in agents.ts.** Nothing else changes.
7. Node/TypeScript ESM, Node ≥22. No Bun (better-sqlite3 + node-pty later).

## 4. Known gaps / TODO in existing code

- `AgentSession.cancel()` reaches into `(session as any).cx` — replace with a proper `ClientContext` handle kept from `connectWith`.
- No `session/load`/`resume` on restart. claude-agent-acp supports it; wire `session_id` from the agents table into `buildSession` so a hub restart resumes conversations.
- `readTextFile` handler ignores `line`/`limit` params.
- Terminal capability (`terminal/*`) not implemented; adapters fall back to their own shell. Fine for now.
- `elicitation/create` not handled → will error if an agent asks. Add a handler that forwards to UI like permissions.
- Mail-wake prompt is a fixed string; make it include a count and the senders so the agent can triage.
- Windows: `spawn(..., {shell: true})` for npx; verify `npx.cmd` path and that the hive MCP `command: process.execPath` works when the adapter itself spawns it.
- `hive doctor` only checks PATH; should run `initialize` against each adapter and report protocol version + auth status (`agentCapabilities._meta.authStatus`).

## 5. Phase 2 — scheduler (do this next)

`jobs` table already exists: `agent, prompt, kind ('once'|'loop'|'interval'|'watch'), remaining, until_ts, every_ms, watch_path, watch_min_lines, fresh_session, next_run, enabled`.

Build `src/core/scheduler.ts`:

- Tick every 1 s. For each enabled job with `next_run <= now` and target agent idle: run it.
- `loop`: run prompt, decrement `remaining`; stop at 0 or `until_ts`. Each iteration is a **fresh ACP session** (new `AgentSession` or `session/new`), plus a persistent notes file: prompt gets `Read and update <cwd>/.hive/notes/<job>.md first; it holds what previous iterations found and what's left.` This is the Ralph-loop pattern; do not run 8 hours in one context.
- `interval`: `every_ms`; same fresh-session rule, `next_run += every_ms`.
- `watch`: chokidar on `watch_path` (ignore .git, node_modules, .hive). Accumulate changed-line count via `git diff --numstat` against a stored ref; fire when `>= watch_min_lines` or on debounce (`every_ms` as max latency). After firing, store the new ref.
- `once`: `run_once_at` semantics.
- Job output: turn events already go to the `events` table; also append a summary row (`jobs_runs`: job_id, started, ended, stopReason, usage). Add that table.
- CLI: `hive loop <agent> --times 5 | --hours 8 "prompt"`, `hive every <agent> 10m "prompt"`, `hive watch <agent> <path> --min-lines 50 "prompt"`, `hive jobs`, `hive job stop <id>`.
- Acceptance: e2e test with mock agent: `loop --times 3` produces 3 turn_end events and 3 job_runs rows; `watch` fires after writing 60 lines to a tmp file and not after 10.

Owner's canonical use cases to keep working: (a) "loop this bug-hunt instruction for 8 hours / 5 times"; (b) a security-review agent that rescans when enough new lines land; (c) a feature-finder agent every 10 minutes; (d) a general coder you talk to.

## 6. Phase 3 — pane UI

- Stack: Electron (needs xterm.js + node-pty for a raw-terminal fallback pane; Tauri is fine if you skip that) + React. Reuse `Hub` in the main process; renderer talks over IPC.
- Grid of panes, resizable, N per row; owner has a 4K monitor and wants many at once. Sidebar list like the Notchlings screenshots: name, model/effort, cwd, idle time, ctx %, unread badge, status note (from `hive_status`).
- Pane renders one session's `SessionEvent` stream: markdown text, collapsible thought, tool cards (title, kind, status, diff from `tool_call_update.content` when `type:"diff"`), plan checklist, permission prompt with the option buttons, `config_option_update` for model/effort selectors (call `session/set_config_option`), context % from `usage_update`.
- Every pane has its own input box. Enter sends `session.prompt`; while busy it queues (claude supports `promptQueueing`).
- Cost readout is low priority per owner; ctx % is wanted.
- Persist layout in `.hive/ui.json`.

## 7. Phase 4 — input routing / voice

- Hover-to-focus: mouse over a pane focuses its input (toggle in settings), plus `Ctrl+1..9` jump and `Ctrl+Tab` cycle. Handy (local STT) types into whatever has OS focus, so this is all that's needed. Optional: global hotkey to focus the "last active" pane.
- Broadcast box: send one prompt to several selected panes.

## 8. Later / nice-to-have

- `git worktree add` per coding agent on `hive add`, merge queue view.
- Session resume on hub restart (see §4).
- Agent "roles" as presets (coder / reviewer / security-watcher / feature-scout) with policy + briefing + default job.
- Read Claude Code's own `~/.claude/projects/*/*.jsonl` for cost history if wanted.
- Subagent sessions from claude-agent-acp (`sessionCapabilities.subagents`) rendered as nested panes.

## 9. Commands

```
npm install
npm test                      # mock e2e
npm run typecheck
npm run dev -- doctor
npm run dev -- chat claude --name zucchini --policy allow-reads --cwd ~/code/x
npm run dev -- run codex --name bongo --policy ask "review src/ and send zucchini: findings"
npm run dev -- agents
```

Env for local Qwen: `QWEN_BASE_URL=http://<t550>:11434/v1 QWEN_MODEL=qwen3-coder QWEN_API_KEY=ollama`.
