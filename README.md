# hive

Local multi-agent harness. One process, any number of coding agents (Claude Code, Codex, Qwen, OpenCode, Gemini, …), all driven through the [Agent Client Protocol](https://agentclientprotocol.com) and all able to message each other.

Design goals, in order:

1. **Your subscriptions keep working.** Every agent is the vendor's own binary behind its official ACP adapter. Auth, sandboxing and permission prompts are the vendor's; hive never re-implements the agent loop.
2. **Agents talk to each other** through a `hive` MCP server injected into every session. Same tools for every vendor, no per-CLI hacks.
3. **Runs 24/7 on one machine.** Nothing listens on the network. No Discord, no WhatsApp.
4. **UI later, protocol first.** The core emits typed events; a terminal CLI renders them today, a pane grid renders them next.

## Status

Phase 1 done: ACP hub + hive bus + mock agent + end-to-end test.

```
npm install
npm test            # two mock agents exchange mail through the hive, permission policies checked
npm run dev -- doctor
npm run dev -- chat claude --name zucchini --policy allow-reads --cwd ~/code/myproject
```

Not yet: scheduler/loops/watchers (phase 2), pane UI (phase 3), hotkeys/cost readout (phase 4).

## Layout

```
src/core/agents.ts     which subprocess to spawn per vendor (add a vendor = add an entry)
src/core/session.ts    one ACP session: spawn, inject hive MCP, stream events, permission policy, mail delivery
src/core/hub.ts        many sessions + delivery loop that wakes idle agents with unread mail
src/hive/db.ts         SQLite: agents, messages, blackboard, event log, jobs (scheduler table, unused yet)
src/hive/server.ts     the MCP server each agent gets (hive_send / hive_inbox / hive_bb_* / hive_status / hive_agents)
src/mock/agent.ts      scripted ACP agent for tests; really calls the hive tools
src/cli/index.ts       run / chat / agents / doctor
test/e2e.ts            the proof
```

## How a message flows

```
alice (claude)  ── hive_send(to: bob) ──▶  sqlite messages
                                              │
hub delivery loop (1.5 s): bob idle && unread>0
                                              ▼
bob (codex)  ◀── prompt: "You have unread hive mail. Call hive_inbox…"
bob ── hive_inbox ── hive_send(to: alice, thread) ──▶ sqlite
hub wakes alice the same way.
```

Agents never block waiting for replies inside a turn; the briefing tells them so. That keeps every vendor's own turn model intact and means an agent that's asleep (process gone) simply gets its mail when it's next started.

Identity is set by the hub through env (`HIVE_AGENT`), not by the agent, so an agent can't impersonate another.

## Permission policy

Per agent: `ask` (forward to UI/terminal), `allow-reads` (auto-approve read/search/fetch, ask for the rest), `allow-all`, `reject-all`. A file watcher/security-review agent should run `allow-reads`; a coder you're watching runs `ask`; an overnight loop you trust runs `allow-all` inside a worktree. The vendor's own sandbox still applies underneath.

## Vendors

| id | adapter | auth |
|---|---|---|
| claude | `@agentclientprotocol/claude-agent-acp` | `claude login` (Max) or `ANTHROPIC_API_KEY` |
| codex | `@agentclientprotocol/codex-acp` | `codex login` (ChatGPT) or `OPENAI_API_KEY` |
| qwen | `qwen --acp` | `QWEN_BASE_URL` → your Ollama/vLLM, `QWEN_MODEL` |
| opencode | `opencode acp` | any provider (DeepSeek, GLM, OpenRouter, local) via opencode.json |
| gemini | `gemini --experimental-acp` | google login |
| mock | built-in | none |

`hive doctor` reports what's installed.

## Next

- **Phase 2 – scheduler.** `jobs` table exists. Add `hive loop <agent> --times 5 | --hours 8 "prompt"`, `hive every 10m`, `hive watch <path> --min-lines 50`. Each iteration = fresh ACP session + a persistent `NOTES.md` the prompt tells the agent to read/update (the Ralph-loop pattern), not one endless context.
- **Phase 3 – pane UI.** Tauri or Electron; each pane subscribes to one session's event stream (text, tool cards, diffs via `tool_call_update.content`, permission prompts, model/effort from `config_option_update`, context % from `usage_update`). Grid layout, N panes on a 4K.
- **Phase 4 – input routing.** Hover-to-focus + `Ctrl+1..9`. Handy types into the focused pane; nothing else needed.
- Worktree per coding agent (`git worktree add`), one checkout per watcher.
