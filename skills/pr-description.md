---
name: pr-description
description: Pull request title, description and changelog line for an agent's branch
agent: claude
policy: allow-reads
params:
  - name: agent
    type: text
    required: true
    description: agent whose branch hive/<agent> to describe
  - name: audience
    type: choice
    choices: [reviewers, users, both]
    default: reviewers
---
Read the work of agent "{{agent}}" with hive_diff (agent: {{agent}}) and hive_log. Write:

1. A PR title (imperative, under 70 characters).
2. A description for {{audience}}: what changed and why, how it was tested, risks / things to check, follow-ups.
3. A one-line changelog entry.

Be concrete and brief; don't invent testing that isn't visible in the diff.
