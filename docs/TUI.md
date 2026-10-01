# hive in the terminal (`hive tui`)

The same hive as the desktop app (agents, groups, review layer, jobs, verdicts), as a pane grid in your terminal. It works in Windows Terminal, PowerShell, GNOME Terminal, Konsole, iTerm and inside tmux or over SSH on the server.

```powershell
cd C:\code\myproject
hive tui                       # first time: a squad of four agents, linked in @squad
hive tui --agent claude --alt codex     # main vendor + second vendor for reviewer/tester
hive tui review-loop           # start from another team (any recipe id)
hive tui --fresh               # ignore the remembered layout
```

**The squad** (recipe `squad`, also in the desktop app's Recipes):

| pane | role | what it does |
|---|---|---|
| 1 planner | tech lead (reads only) | turns your goal into tasks, hands them to the coder, keeps the plan on the blackboard |
| 2 coder | coder, own worktree | implements, commits in small steps |
| 3 reviewer | reviewer (second vendor) | reviews every batch of new commits automatically |
| 4 tester | tester (second vendor, own worktree) | runs tests, types and lint on every batch, reports failures |

Next time, `hive tui` reopens the same panes and resumes their sessions.

## Typing

- Type and press **Enter**: it goes to the **focused** pane (yellow border).
- `@coder fix the login bug`: send to a specific agent. `@squad standup`: send to a whole group.
- `y` / `n` (with an empty prompt) answers a permission question shown in the pane.
- **Tab** / **Shift+Tab**: next or previous pane. **Alt+1..9**: jump to a pane. **PgUp/PgDn**: scroll.
- **Esc** cancels the focused agent's turn. **Ctrl+C** twice quits; agents stop and sessions resume next time.

## Commands

```
/add <agent> [role] [name]   /add codex reviewer · /add claude coder c2 · /add gemini-api chat
                             roles: coder reviewer security scout bughunter planner tester chat
/rm [name]                   close a pane (--forget also removes the agent)
/link a b [--review]         let them talk; --review = you approve each message
/group <name> a b …          @name reaches all members · /groups · /unlink <group>
/scope open|linked           linked: agents only talk to agents they're linked with
/held · /release <id> · /drop <id>     messages waiting for your review
/team [recipe]               add a whole team
/focus <n|name> · /zoom · /all <msg> · /stop [name]
/verdict <prompt> --agents claude,codex [--text]   several agents, one judge
/usage · /help · /quit
```

The status bar shows how many agents are working, which are ready (✓, finished while you were elsewhere), and what's waiting for you (permission questions and held messages).
