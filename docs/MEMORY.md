# Memory and learning

hive gets to know you and your projects, and turns things you keep asking for into skills. **Nothing is learned without your OK.**

Open it with **Ctrl+K → "Memory and learning"**, or **Hive → Learning**. The Hive button's number includes suggestions waiting for you.

## What hive remembers

| | File | Who reads it |
|---|---|---|
| **About you** | `<hive home>/memory/owner.md` | every agent, in every project |
| **About this project** | `<hive home>/projects/<project>/memory.md` | every agent in this project |

Both are plain markdown lists. Add lines in the Learning tab, with `hive memory add owner "…"`, or edit the files by hand. Every new agent gets them in its briefing.

Good lines are short, lasting facts:

- `Makes YouTube videos about coding for beginners`
- `Uses PowerShell on Windows, not bash`
- `Prefers small PRs with a one-line summary`
- `Tests: npm test` · `Never touch the render/ folder`

Keys, passwords and tokens are refused. So is anything that looks like "ignore previous instructions".

**Start here:** spend 5 minutes adding 5–10 lines about yourself: your role, your tools, what you make, and what agents should avoid. Then hive isn't starting cold.

## How it learns

1. **After a real conversation.** Once you've sent an agent 3 messages, a hidden helper of the same kind reads the chat when its turn ends. It uses the same subscription, reads no files, and starts a fresh conversation. It runs at most once per agent every 30 minutes. It suggests:
   - up to 3 lines about you and 3 about the project, learned only from what **you** said or clearly showed, never from web pages or other agents;
   - a **skill** when it sees a procedure you'll repeat.
2. **Repeats.** Your messages from the last 30 days that look alike, for example "youtube title ideas for my X video" three times, are flagged as skill candidates. This is plain word matching; no model is needed.
3. **Agents can suggest too.** When you tell an agent "always…", "never…" or "remember that…", it can call `hive_remember`. That also only creates a suggestion.
4. **You decide.** Each suggestion shows where it came from. **Accept** (edit it first if you like) or **Reject**. Rejected suggestions aren't suggested again. Accepted skills go to your skills folder marked `learned: true`, and you run them like any other skill.
5. **Clean-up.** A learned skill nobody has run in 30 days gets a "remove it?" suggestion. Skills you wrote yourself are never touched.

**"Learn from this chat now"** in the Learning tab runs step 1 on demand.

## Cost and control

- The helper's turns are **automatic work**: daily caps, reserves and **pause** apply. They show as **learning** in Token stats.
- Turn it off with the **Learn from my sessions** switch. Memory you already have keeps working.
- Everything stays on your machines: memory files, suggestions (in the project's hive.db) and skills.

## Command line

```bash
hive memory                         # list both
hive memory add owner "Uses PowerShell on Windows"
hive memory rm project 2
hive learn                          # suggestions waiting
hive learn accept 7 · hive learn reject 8
```
