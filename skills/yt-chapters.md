---
name: yt-chapters
description: YouTube chapters (timestamps) from a timed transcript (.srt/.vtt)
agent: claude
policy: reject-all
params:
  - name: transcript
    type: file
    required: true
    description: .srt or .vtt with timestamps
  - name: max_chapters
    type: number
    default: 12
---
Create YouTube chapters from this timed transcript.

Rules (YouTube requirements): the first chapter starts at 0:00; at least 3 chapters; each at least 10 seconds long; timestamps ascending. Use at most {{max_chapters}} chapters, placed where the topic genuinely changes. Titles: 2-6 words, specific, no numbering.

Output only the chapter list, one per line, like:
0:00 Intro
1:24 Why the first try failed

Transcript:
{{transcript}}
