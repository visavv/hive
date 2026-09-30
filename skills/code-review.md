---
name: code-review
description: Review an agent's branch (or your current branch) for bugs, risks and simpler approaches
agent: claude
policy: allow-reads
params:
  - name: agent
    type: text
    description: agent whose branch to review (e.g. coder); empty = the current folder's branch
  - name: focus
    type: text
    description: anything to look at especially (security, performance, tests…)
---
Review {{#if agent}}the work of agent "{{agent}}" — read it with hive_diff (agent: {{agent}}) and hive_log{{/if}}{{#if focus}} with special attention to: {{focus}}{{/if}}. If no agent is given, review the uncommitted and unmerged changes in the current folder (git diff / git log against the main branch).

Report, most severe first:
1. Bugs and correctness problems (file:line, what goes wrong, a fix).
2. Security or data-loss risks.
3. Missing tests for important cases.
4. Simpler or more idiomatic approaches, and duplicated logic that already exists elsewhere.
Skip formatting nits. End with a one-line verdict: ready to merge / needs changes.
