# Teamwork

## Broadcasting one task to several agents

The **Team / Each** switch next to **Send** in the top bar decides what a broadcast does.

- **Team** (default): hive picks **one lead**:
  - a planner or lead role first, then a coder, then the first agent that can act;
  - a chat-only agent never leads.

  The lead gets the task, the list of teammates and their roles, and a brief: make a short plan, then `hive_send` each teammate the part that fits their role, then do its own part. The other agents show *"zucchini (coder) is leading — this agent waits for its part by mail"* and spend no tokens until that mail wakes them. Nobody duplicates work, and a reviewer reviews once there is something to review.
- **Each**: the same message goes to every agent, as before.

Tick pane boxes to broadcast to only some agents.

## Grouping

Tick two or more pane boxes, then click **Group N** in the top bar. You can also drag one pane's name onto another pane.

## Improvement ideas → coder → you

An agent that finds improvements (the **Feature scout** preset, or any agent on an improvement job) sends the best new ideas, numbered, to the coder agent. The coder doesn't build them on its own. It lists them a line each and asks you which to do. Answer in its pane: "do 1 and 3", or "no".

Every agent's briefing carries these rules (`src/core/team.ts`), so they apply to agents without a preset too.
