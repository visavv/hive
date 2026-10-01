# Voice: dictation and spoken replies

You can talk to your agents. Every prompt box (each pane, and the broadcast box at the top) has a **mic button**. Each agent can also **answer out loud** in its own voice.

- **Dictation:** click the mic, talk, click again. The text appears where your cursor is. You can also hold **Ctrl+Shift+Space**, talk, and let go. A quick tap of that key keeps the mic on until you press it again. Esc cancels.
- **Spoken replies:** click the speaker icon in a pane's header and turn on *Speak replies*. When that agent finishes, you hear a short summary (2–3 sentences, at most about 400 characters). Code, tables and file paths are left out. Press Esc or click the pane to stop it.
- **Conversation mode:** open the palette (Ctrl+K) and pick *Talk with &lt;agent&gt;*. What you say is sent right away and the reply is spoken. Then hive listens again and stops after about 1.5 s of silence. Turn off *Hands-free conversation* in the palette if you'd rather click the mic each time. While it's on, the pane shows a **talk / listening / speaking** badge.

Speech-to-text and text-to-speech run in the hive backend, never inside an agent, so your API keys stay in the hive process. Audio goes only to the provider you pick.

## 1. Pick a speech-to-text provider

| provider | set | cost | privacy |
|---|---|---|---|
| **local** Whisper server | `HIVE_STT_URL` | free (your CPU/GPU) | audio never leaves your machine |
| **OpenAI** | `OPENAI_API_KEY` (or `HIVE_STT_KEY`) | billed per minute of audio, see OpenAI's pricing page | audio goes to OpenAI |
| **ElevenLabs** Scribe | `ELEVENLABS_API_KEY` | counts against your ElevenLabs plan | audio goes to ElevenLabs |

hive uses the first one that's set, in the order above. To choose one yourself, set `HIVE_STT=local`, `openai` or `elevenlabs`. Restart hive after you change any of these. The **Accounts** tab of the Hive drawer (Ctrl+I) and the palette's *Dictation: set up* show what hive found.

Other settings:

| variable | what it does |
|---|---|
| `HIVE_STT_MODEL` | model name. local: sent only when you set it. openai: defaults to `gpt-4o-mini-transcribe`. elevenlabs: defaults to `scribe_v1`. Provider model names change, so set this yourself if a default stops working. |
| `HIVE_STT_LANGUAGE` | language hint, e.g. `en` or `fi` (optional; auto-detected otherwise) |
| `HIVE_STT_KEY` | key for OpenAI, or a Bearer token for a local server that wants one |
| `HIVE_STT_BASE` | another OpenAI-compatible service (default `https://api.openai.com/v1`) |
| `HIVE_STT_MAX_SECONDS` | longest clip, default 300. Clips are also capped at 25 MB. |

## 2. Local Whisper (free, private)

Any server with an OpenAI-compatible `/v1/audio/transcriptions` endpoint works. For `HIVE_STT_URL` you can give the full endpoint, a `…/v1` base, or just `http://host:port`.

### Windows, with an NVIDIA GPU (whisper.cpp)

1. Download a whisper.cpp release from https://github.com/ggml-org/whisper.cpp/releases. Take the CUDA build (`cublas` in the name) if you have an NVIDIA card, or the plain x64 build otherwise. Unzip it, for example to `C:\whisper`.
2. Download a model from https://huggingface.co/ggerganov/whisper.cpp. `ggml-base.en.bin` is fast and English-only. `ggml-large-v3-turbo.bin` is better and multilingual, and needs a GPU to be quick. Put it in `C:\whisper\models`.
3. Install ffmpeg (`winget install ffmpeg`). The browser records webm/opus, and `--convert` lets whisper.cpp read that.
4. Start the server:
   ```powershell
   C:\whisper\whisper-server.exe -m C:\whisper\models\ggml-base.en.bin --host 127.0.0.1 --port 8080 --inference-path /v1/audio/transcriptions --convert
   ```
5. Tell hive where the server is, then restart hive:
   ```powershell
   setx HIVE_STT_URL http://127.0.0.1:8080
   ```

### Linux (whisper.cpp, or speaches in Docker)

whisper.cpp: build it (`cmake -B build && cmake --build build -j`, and add `-DGGML_CUDA=1` for an NVIDIA GPU), download a model as above, install ffmpeg, then run:

```bash
./build/bin/whisper-server -m models/ggml-base.en.bin --host 127.0.0.1 --port 8080 --inference-path /v1/audio/transcriptions --convert
export HIVE_STT_URL=http://127.0.0.1:8080
```

speaches (formerly faster-whisper-server) runs in Docker. Use the `-cuda` image if you have a GPU. It needs a model name:

```bash
docker run -d -p 8000:8000 ghcr.io/speaches-ai/speaches:latest-cpu
export HIVE_STT_URL=http://127.0.0.1:8000 HIVE_STT_MODEL=Systran/faster-whisper-small
```

Image tags and model names come from those projects, so check their READMEs if one has changed. A GPU is optional: on a modern CPU the base/small models take about a second for a short sentence.

## 3. Spoken replies (ElevenLabs)

Set `ELEVENLABS_API_KEY`. This is the same key `hive tts` uses. Each pane's speaker menu has these settings:

- **Speak replies**: on or off for that agent.
- **Voice**: hive lists your ElevenLabs voices, so you can give every agent its own. The choice is saved in the layout. If you pick none, hive uses `ELEVENLABS_VOICE` or the ElevenLabs default.
- **Preview**: hear the voice before you choose it.

Only the summary is sent to ElevenLabs, never the whole reply. Turns that hive started itself (jobs, mail between agents) are spoken only while you are looking at that pane. You can turn even that off in the palette (*Speak job/mail turns of the focused pane*).

## Budget and stats

Each transcription and each spoken reply counts as one call against the daily media cap: `hive budget set media_daily=N`, default 40. Raise it if you dictate a lot. Calls show up in token stats (`hive stats`, or the Stats view):

- transcriptions under kind `stt:<provider>`, task *dictation*
- spoken replies under kind `tts`, task *voice*

They are counted as calls, not tokens.

## Settings (Ctrl+K)

- *Send after dictation*: send the prompt as soon as the text arrives. Off by default, so you can check the text first.
- *Push-to-talk key*: switch between Ctrl+Shift+Space, Ctrl+Space, Alt+Shift+Space, F9 and off.
- *Hands-free conversation*: whether conversation mode listens again after each spoken reply.
- *Talk with &lt;agent&gt;*, *Voice for &lt;agent&gt;…*, *Speak replies from &lt;agent&gt;*.

## Using it alongside Handy

[Handy](https://github.com/cjpais/Handy) dictates system-wide and types into whatever has focus. hive's hover-to-focus mode (palette: *Hover to focus panes*) lets it type into the pane under your mouse. hive's own dictation is separate and doesn't get in Handy's way:

- Handy's default shortcut on Windows is **Ctrl+Space**. That's why hive's push-to-talk defaults to **Ctrl+Shift+Space**. If you changed Handy's shortcut, you can move hive's to Ctrl+Space or F9.
- Use whichever you like. Handy works in every app. hive's mic works in hive, on your phone too, and adds conversation mode.

## Phone and browser

The mic works the same when you open hive in a browser over `hive web`. Browsers only allow the microphone on **https** or **localhost**, so open hive through an https address (for example Tailscale Serve) on your phone.

## Privacy and security

- Audio is recorded only while the mic button is red (or the pane shows *listening*). It goes to the provider you chose and nowhere else. hive doesn't save recordings.
- The desktop app gives microphone access only to its own page, and only audio, never the camera. All other permission requests are denied, except notifications and clipboard writes, which hive already uses.
- Replies play from memory (Web Audio). The page loads nothing from the network.
