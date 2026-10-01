---
name: motion
description: Motion graphics (title card, lower third, logo reveal) as an HTML animation hive renders to MP4 / ProRes with alpha
agent: claude
policy: ask
params:
  - name: name
    type: text
    required: true
    description: folder name, e.g. ep12-title (becomes out/motion/<name>/)
  - name: brief
    type: text
    required: true
    description: what it should show and feel like (text, colours, mood, length)
  - name: size
    type: choice
    choices: [1920x1080, 3840x2160, 1080x1920, 1080x1080]
    default: 1920x1080
  - name: duration
    type: number
    default: 5
  - name: transparent
    type: choice
    choices: [no, yes]
    default: no
    description: yes = an overlay with no background (lower third, logo bug) rendered as ProRes 4444 with alpha
---
Make a motion graphic as a self-contained HTML animation in out/motion/{{name}}/index.html.

Brief: {{brief}}
Size: {{size}}. Duration: {{duration}} seconds. Transparent overlay: {{transparent}}.

If out/motion/{{name}}/ doesn't exist yet, start from a template: run `hive motion new {{name}}` (copies the kinetic title card). Otherwise edit what is there.

The page MUST follow hive's render contract, or it can't be rendered:
- Expose `window.hiveRender = { duration, fps, width, height, seek(t) }` with width/height from the size above and fps 30 (or 60 for fast motion).
- `seek(t)` draws the frame at t seconds from scratch. Every visual must be a pure function of t: no setTimeout, setInterval, requestAnimationFrame loops, CSS animations/transitions, Date.now() or unseeded Math.random(). Use a small seeded random if you need noise.
- Everything the page uses must be inside out/motion/{{name}}/: no CDN links, no remote fonts or images (remote URLs are blocked during rendering). If you use a library such as three.js, copy its module file into the folder (e.g. from node_modules) and import it with a relative path.
- If the overlay is transparent, give the background its own element and hide it when the URL has `?alpha=1` (hive adds that for --alpha renders); keep html/body transparent.
- Keep text inside the title-safe area (5% margin), sizes relative to the frame (vh/vw or canvas units) so another --size still looks right.

When done, check it renders a few frames: `hive render out/motion/{{name}} --frames --seconds 1` (PNG frames, no ffmpeg needed), look at one, then tell the owner the command for the final video:
- `hive render out/motion/{{name}}` → MP4 (H.264)
- `hive render out/motion/{{name}} --alpha --out out/motion/{{name}}.mov` → ProRes 4444 with transparency for DaVinci Resolve
