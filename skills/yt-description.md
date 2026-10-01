---
name: yt-description
description: Video description (hook, summary, key points, links placeholder, tags) from a transcript
agent: claude
policy: reject-all
output: out/{name}-{date}.md
params:
  - name: transcript
    type: file
    required: true
    description: transcript (.txt/.srt/.vtt) or a YouTube link
  - name: title
    type: text
    description: the final title
  - name: links
    type: text
    description: links / sponsors / socials to include
  - name: notes
    type: text
    description: tone, what to emphasize
---
Write a YouTube description for this video{{#if title}} titled "{{title}}"{{/if}}.

Structure:
1. First two lines (shown above "more"): a hook that makes someone want to watch, no hashtags, no links.
2. A short paragraph on what the viewer will learn or see.
3. "In this video" — 3-6 bullet points of concrete takeaways from the transcript.
4. {{#if links}}Links section using exactly these: {{links}}{{/if}}
5. 10-15 search tags (comma separated) people would actually type.

Keep it natural and specific to what's said in the transcript; no generic filler.
{{#if notes}}Creator's notes: {{notes}}{{/if}}

Transcript:
{{transcript}}
