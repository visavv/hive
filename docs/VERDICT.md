# Verdict mode: several agents, one judge

Send one prompt to two or more agents at the same time. A judge compares their results without knowing who wrote which, finds bugs, and decides what the final version should take from each. One click then has the author of the best base build the merged version.

Use it for initial work where getting it right matters: a new feature, a tricky function, an architecture sketch, or in text mode titles, hooks, plans and prompts.

**Cost:** one turn per contender plus one for the judge (plus one if you build the merge). It only runs when you start it.

## In the app

1. **⚖ Verdict** in the top bar, or **⚖ Verdict…** in the big prompt editor (Ctrl+E) to use the prompt you're writing.
2. Pick two or more **contenders** (e.g. Claude Code + Codex + Gemini) and a **judge**: the strongest model you have. Optionally set the judge's model id.
3. Pick a mode:
   - **Code**: each contender works in its own git worktree (branch `hive/v<id>-<n>-<agent>`). By default they may edit and run freely there; your checkout is untouched. Choose "ask me before edits" to approve each change.
   - **Text**: answers only, no files.
4. **Start.** You can close the window; you get a ping and a ✓ when the verdict is ready.
5. The verdict window shows each solution's status and diffstat, then the judge's verdict:
   - bugs with file:line;
   - a score table;
   - what to take from which solution;
   - a merge plan, or in text mode a final combined answer.
6. **Build merged version**: the author of the judge's pick (or the one you choose) builds the final version in its worktree, following the verdict and fixing the listed bugs. Review and merge it from the sidebar's worktrees (or `hive merge <agent>`).

The report, with the contenders revealed, is saved to `out/verdicts/verdict-<id>.md`.

## In the terminal

```powershell
hive verdict "add rate limiting to the API client, with tests" --agents claude,codex,gemini-api --judge claude
hive verdict "10 title ideas for: <video summary>" --agents claude,gemini-api --text
hive verdict list · hive verdict show 3 · hive verdict apply 3 [--label B]
```

## How it keeps the judge honest

- Solutions are labelled A/B/C in random order, so the judge doesn't know which vendor wrote which.
- Each solution reaches the judge as untrusted data. A contender can't instruct the judge ("pick me") through its output.
- In code mode the judge sees the real diff since the start (committed or not), and the working-copy paths so it can read the code itself. It is told not to trust the summaries.
- The judge runs read-only (`allow-reads`).
