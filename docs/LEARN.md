# Learn while you build

Agents write your app. This page shows how to read what they wrote and get it explained, step by step, so you learn to code along the way.

## 1. Open the code

- Press **Ctrl+P** (or **Ctrl+K** and type "Open file…"), then type part of a file name and press Enter.
- Or **Ctrl+K → "Browse code"** to start from the file tree.
- Or click a file path in an agent's pane: on a tool card ("edit src/app.ts") or above a diff. The file opens at that line.

The code view shows the **focused agent's folder**. If that agent works in its own worktree (a private copy of the project on a branch like `hive/coder`), you see its version. Switch to another agent's folder, or the main project, with the menu at the top left.

What you see:

- **File tree** on the left. Folders open when you click them. Files the project ignores (`.gitignore`) are left out.
- **Marks:** `M` = modified (changed but not committed yet), `N` = new file. A dot on a folder means something inside changed.
- **Colours:** keywords, strings, comments and names have different colours (syntax highlighting). They follow your theme.
- **Changes tab:** everything the agent changed compared with the main branch, with added lines in green and removed lines in red.

Nothing in the code view can change a file. It only reads.

## 2. Ask about any lines

1. Select lines: drag over the code, or click a line number and Shift+click another.
2. A small toolbar appears:
   - **Explain** – what these lines do, step by step.
   - **Why like this?** – why it was written this way, and what would break otherwise.
   - **Simpler?** – whether it could be simpler, and the trade-off.
   - **Quiz me** – one question to check you understood. Answer it in the teacher's box; it tells you what was right.
   - **Ask…** – type your own question.
3. The question goes to your **teacher** together with the file name, the line numbers and the code itself. The answer appears on the right, next to the code. Press Esc to clear the selection, Esc again to close the code view.

If no teacher is running yet, hive offers to start one (pick the agent type; Claude is the default).

## 3. The teacher

The teacher is an agent with one job: explain the code to a beginner. You can also start one any time with **Ctrl+K → "Start a teacher"**, or pick the `teacher` preset when adding an agent.

It:

- only reads code – it never changes files, even if you ask (it explains how you could do it instead);
- answers in short paragraphs and ties every idea to the exact lines;
- explains each technical word the first time it uses it;
- asks one check-your-understanding question when you choose "Quiz me";
- sometimes suggests a tiny exercise you can try.

You can talk to it like any agent, in the box under its answers or in its own pane.

### Glossary cards

When a new term comes up that a beginner should know ("promise", "props", "migration"…), the teacher adds a card to your board (**Ctrl+J**) with the label **glossary**: the word, a short definition, and where in the code it appeared. It checks first, so each term appears once. Search the board for "glossary" to review them.

## 4. Explain every change

Turn this on for an agent (the **Explain every change** box at the top of the code view, or **Ctrl+K → "Explain every change by …"**). From then on, each time that agent finishes a turn that changed files, the teacher gets the list of files and the diff and explains in plain words what changed and why.

**Token cost:** every explanation is a real agent turn, so it uses tokens (or your subscription's limits) like any other prompt. To keep it in check:

- the diff sent is cut to about 8 KB;
- at most one explanation per agent every 2 minutes – changes in between are bundled into the next one;
- it counts as **automatic work**, so your spending guards apply: if a daily budget is reached, a subscription window is nearly full, or you paused automatic work (Usage panel), explanations wait instead of running.

Turn it off the same way when you don't need it.
