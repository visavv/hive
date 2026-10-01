# Creator tools

hive's creator features, step by step. Everything here runs on your own
machine with your own keys; nothing is uploaded or posted for you.

- [Twitch clips pipeline](#twitch-clips-pipeline): new VODs and clips become board cards; agents cut them into shorts
- [Extra MCP servers](MCP.md): DaVinci Resolve and other tools for agents
- [Ideas for later](#ideas-for-later)

## Twitch clips pipeline

**What it does:** every 10 minutes hive asks Twitch for your channel's new
past broadcasts (VODs) and clips. Each new one becomes a card in **Draft** on
your board (Ctrl+J in the app, or `hive board`), labelled `twitch` + `vod` or
`clip`, with the link, duration and date. With the recipe, a **clipper** agent
then downloads it, finds the best moments, cuts vertical shorts into
`out/clips/`, comments on the card and moves it to Done; a **studio** agent
writes title ideas for each short.

### 1. Get Twitch API keys (free, once)

1. Go to <https://dev.twitch.tv/console>, sign in, **Register Your Application**.
2. Name: anything (e.g. "hive"). OAuth Redirect URL: `http://localhost`. Category: "Application Integration". Client type: **Confidential**.
3. Open the app: copy the **Client ID**, press **New Secret** and copy the secret.
4. Put them in your environment (never in a file inside your project):
   - Windows (PowerShell): `setx TWITCH_CLIENT_ID "…"`, `setx TWITCH_CLIENT_SECRET "…"`, `setx TWITCH_CHANNEL "yourlogin"`, then open a new terminal / restart the app.
   - Linux: add `export TWITCH_CLIENT_ID=…` (and the other two) to `~/.bashrc` or `~/.config/environment.d/hive.conf`.

`TWITCH_CHANNEL` is your channel's login name (the part after `twitch.tv/`).
hive only reads public data (VODs, clips), so it uses an app token: no
"Log in with Twitch" needed. The token stays in memory; it's never written to
a database or file. Agents never see the secret.

### 2. Try one poll

```
hive twitch poll
```

The first poll of a channel adds cards for the newest 3 VODs and 3 clips only
and remembers the rest as seen, so years of history don't flood your board.
Run it again: nothing new is added.

### 3. Set up the pipeline

```
hive recipe apply twitch-clips --cwd D:/videos/stream
```

(or the app's Recipes dialog). This adds the clipper and studio agents, a
`clips` group (you're in it) and turns on polling every 10 minutes for this
project. Keep the app or `hive serve` running; that's what polls and wakes the
agents.

The clipper needs these programs on the machine where hive runs:

| program | what for | install |
|---|---|---|
| `yt-dlp` | downloads VODs and clips | Windows: `winget install yt-dlp`; Linux: `pipx install yt-dlp` or your package manager |
| `ffmpeg` | cuts and crops the shorts | Windows: `winget install ffmpeg`; Fedora: `sudo dnf install ffmpeg` (RPM Fusion); Ubuntu: `sudo apt install ffmpeg` |
| chat replay (optional) | finds moments where chat went wild | `TwitchDownloaderCLI` or `pip install chat-downloader` |
| `whisper` (optional) | transcripts when there is no chat replay | `pip install openai-whisper` (runs locally) |

Other commands:

```
hive twitch watch                 # poll in this terminal every 10 min (Ctrl-C stops)
hive twitch watch --every 30m --detach   # let hive serve / the app poll, every 30 min
hive twitch off                   # stop polling for this project
hive twitch poll --channel otherlogin --in-project podcast
```

### What it costs

- Twitch API: free.
- The clipper and studio are normal agents: each new VOD or clip is one or two
  agent turns. With a Claude or ChatGPT subscription that counts against your
  plan's limits; with an API model you pay per token. hive's budget guards
  (`hive budget`, the Usage view) apply: automatic turns stop at your daily cap
  and when a subscription window is 85% used.
- Downloads and cutting run on your machine (disk space: a 3-hour VOD at 1080p
  is several GB; the clipper only downloads the parts it needs when it can).

### Safety notes

- Clip titles are written by viewers. hive marks card text and blackboard
  entries from Twitch as untrusted, and the clipper's briefing says to treat
  them as data.
- The clipper runs with `allow-all` (it has to run yt-dlp and ffmpeg) and is
  told to write only under `out/clips/`. Give it its own folder for stream
  material, not your code checkout. If you'd rather approve each command, open
  it in the app and switch its permissions to `ask` (unattended jobs then wait
  up to 15 minutes for you and skip the step if you don't answer).
- Nothing is uploaded anywhere. Posting the shorts is up to you.

## Ideas for later

- **Screen region → vision.** Pick a rectangle of your screen in the desktop
  app (a game's quest text, a chat in another language, a slide) and have a
  vision model answer, describe or translate it every few seconds, with
  identical frames skipped to save tokens. Not built yet.
