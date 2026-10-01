---
name: yt-titles
description: Title ideas for a video from its transcript, your working title and your notes
agent: claude
policy: reject-all
output: out/{name}-{date}.md
params:
  - name: transcript
    type: file
    required: true
    description: transcript (.txt/.srt/.vtt) or a YouTube link
  - name: working_title
    type: text
    description: the title you have now, if any
  - name: notes
    type: text
    description: your thoughts, angle, what the video is really about
  - name: advice
    type: text
    description: rules you follow (length, words to avoid, channel style)
  - name: count
    type: number
    default: 12
---
You are helping a YouTube creator title a video. Read the transcript and find what is genuinely interesting, surprising or useful in it — the promise the video actually delivers on.

Write {{count}} title options. Mix these angles: curiosity gap, clear outcome/benefit, contrarian or surprising claim, specific number or result, personal story. Rules:
- Honest: every title must be backed by something in the transcript. No bait the video doesn't pay off.
- Mostly under 60 characters; front-load the strongest words.
- Plain language, no ALL CAPS words, at most one emoji across the whole list.
{{#if advice}}- Creator's own rules (these win): {{advice}}{{/if}}

{{#if working_title}}Current working title: "{{working_title}}". Say in one line what's weak or strong about it, and include 2 improved versions of it in the list.{{/if}}
{{#if notes}}Creator's notes on the video: {{notes}}{{/if}}

Output:
1. A numbered list of titles, each followed by the angle in brackets, e.g. "… [curiosity]".
2. Your top 3 picks with one sentence each on why, and which thumbnail text would pair with each (max 4 words).

Transcript:
{{transcript}}
