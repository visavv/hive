# hive on your phone

The full hive app (agents, permission prompts, board, inbox) on your Android phone, either in Chrome
or as a small app (APK). Your agents still run on your computer or server; the phone is a screen for them.

```
phone (Chrome or the hive app) ──HTTPS, only inside your tailnet──▶ tailscale serve ──▶ hive web (127.0.0.1:7777) ──▶ your project's hive
```

## 1. On the computer (once)

You need [Tailscale](https://tailscale.com/download) on the computer and on the phone, signed in to the **same account**.

```bash
npm run ui:build                 # in your hive checkout: builds the app (also the phone version)
cd ~/code/my-project             # the project you want on the phone
hive web                         # keep this running (or use the service below)
```

In another terminal, once:

```bash
tailscale serve --bg 7777        # publishes hive web over HTTPS to your own devices only
```

`hive web` prints a line like:

```
  on your phone:    https://my-pc.tail1234.ts.net/#t=Xk3…
```

That whole line is the address **and the key**. Treat it like a password.

**Keep it running after reboots** (Linux server/VM): `bash scripts/setup-remote.sh --project ~/code/my-project --web`
installs a service and runs `tailscale serve` for you. The address is then in `sudo journalctl -u hive-web-my-project | grep 'on your phone'`.

## 2a. In Chrome (quickest)

1. Open the Tailscale app on the phone and switch it on.
2. Send yourself the address (e.g. from the computer to your phone with a note or chat to yourself) and open it in Chrome.
3. Chrome menu (⋮) → **Add to Home screen** → **Install**. hive now opens full screen from its icon, instantly.

The key is remembered on the phone and removed from the address bar. If you ever see "Paste the link…", paste the address again.

## 2b. The Android app (APK)

1. On GitHub: your repo → **Actions** → the latest green **ci** run → **Artifacts** → download **hive-android-apk** and unzip it (you get `app-debug.apk`).
2. Copy it to the phone and tap it. Android asks to allow installing apps from that source (Files or Chrome): allow it once.
3. Open **hive**, paste the address from step 1, tap **Open hive**. Allow the microphone when asked (for dictation).

Updating: a new CI build is signed with a new debug key, so uninstall the old hive app first, then install the new APK
(you'll paste the address again). To use another computer or project: Menu → **Change hive address**.

The app only opens `….ts.net` addresses (what `tailscale serve` gives you); anything else opens in the browser.
To build it yourself instead: `cd mobile && npm ci && npm run apk` (needs Java 21 and the Android SDK).

## Using it

- One agent per screen. The bottom bar lists your agents with a state dot (amber = needs you); tap one, or swipe left/right on the conversation.
- **Board**: your Kanban; swipe sideways between Draft, In progress and Done.
- **Inbox**: mail from agents and messages waiting for your review.
- **Menu**: new agent, teams, skills, usage, all commands and themes.
- Permission prompts are big Allow / Deny buttons in the conversation. Back closes whatever sheet is open.
- Lost connection (phone asleep, switching networks) shows "reconnecting…" and comes back by itself.

## Security

- `hive web` listens on **127.0.0.1 only**: nothing on your Wi-Fi or the internet can reach it. `tailscale serve` makes it
  reachable over HTTPS from devices signed in to your tailnet, nobody else (not `tailscale funnel`, which would be public).
- Even on your tailnet, the connection needs the project's key (32 random bytes, stored readable by you only in hive's state
  folder for the project) and must come from the hive page itself (Origin check), so other websites open on your phone can't use it.
- Whoever has the key can drive your agents, which run commands as you. Don't share the address. Lost a phone? `hive web --new-token`
  makes a new key (restart the service if you use one) and the old one stops working.
- The page loads nothing from the internet (strict Content-Security-Policy). The app keeps the address only on the phone and is excluded from Android backups.

## Troubleshooting

| You see | Do this |
|---|---|
| "Can't reach hive" / the page doesn't load | Tailscale on in the phone? Computer awake? `hive web` running? `tailscale serve status` shows `127.0.0.1:7777`? |
| "Paste the link…" or "That key doesn't open this hive" | Paste the latest address `hive web` printed (the key changes after `--new-token`). |
| `the web UI isn't built` when starting hive web | Run `npm run ui:build` in the hive checkout. |
| "App not installed" when updating the APK | Uninstall the old hive app first. |
