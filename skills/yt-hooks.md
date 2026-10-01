---
name: yt-hooks
description: Opening hooks (first 15 seconds) and thumbnail text options
agent: claude
policy: reject-all
params:
  - name: transcript
    type: file
    required: true
    description: transcript (.txt/.srt/.vtt) or a YouTube link
  - name: title
    type: text
  - name: notes
    type: text
---
From this transcript{{#if title}} for the video "{{title}}"{{/if}}, write:

A) 5 opening hooks for the first 10-15 seconds (spoken lines, each max 2 sentences). Each should set up the payoff the video delivers and make leaving feel like a loss. Label the technique: question, bold claim, result-first, story, stakes.

B) 8 thumbnail text options, max 4 words each, that complement (not repeat) the title.

C) Which hook + thumbnail text pair is strongest, and why, in 2 sentences.

{{#if notes}}Creator's notes: {{notes}}{{/if}}

Transcript:
{{transcript}}
