---
name: yt-shorts
description: Short-form clip ideas (with timestamps if available) from a long video transcript
agent: claude
policy: reject-all
output: out/{name}-{date}.md
params:
  - name: transcript
    type: file
    required: true
    description: transcript with timestamps (.srt/.vtt) or a YouTube link
  - name: count
    type: number
    default: 6
---
Find the {{count}} best moments in this transcript to cut into Shorts (under 60 seconds each).

For each: start–end timestamps (if the transcript has them), a one-line reason it works on its own, a hook line to put on screen in the first second, and a title. Prefer moments with a complete idea, a surprise, a strong opinion or a visible result. Rank them best first.

Transcript:
{{transcript}}
