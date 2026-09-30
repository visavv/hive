---
name: idea-polish
description: Turn a rough idea into a brief you can act on (or an honest "don't")
agent: claude
policy: reject-all
params:
  - name: idea
    type: text
    required: true
  - name: context
    type: text
    description: who it's for, constraints, what you already have
---
Rough idea: {{idea}}
{{#if context}}Context: {{context}}{{/if}}

Stress-test it first: who exactly benefits, what they do today instead, and the strongest reason it might not be worth doing. If it doesn't survive, say so and suggest a better variant.

If it does, write a brief: Problem · Who benefits · Proposal · Smallest first version (can be done in a day) · How to know it worked · Risks · Effort (S/M/L).
