# Device panes: a sandboxed browser and an Android device

hive can show two kinds of device next to your agents:

- **Browser**: a web browser inside hive that agents can drive to test the web app they're building.
- **Android**: an Android emulator, or your own phone over USB or Wi-Fi.

You watch both live, and you can click and type into them. Agents use the same browser and the same phone through tools.

Open them with **Ctrl+K → "Open browser…"** or **"Android device…"**. A pane also opens by itself when an agent starts using a device. If you close it, it stays closed for two minutes.

## The sandboxed browser

### What "sandboxed" means

- hive runs **its own Chromium**, separate from your Chrome, Edge or Firefox. It has its own profile, so it **never sees your cookies, saved passwords or logins**.
- The profile is kept **in memory** by default and forgotten when the browser closes (after 30 idle minutes, or when hive exits).
- **"Keep logins for this project"** stores the profile in hive's state folder for this project (`<hive home>/projects/<repo>/browser-profile`). Logins then survive restarts. That profile still belongs only to hive, never to your own browser. Anything you sign into there, agents can see too.
- The page never runs inside hive's window. The backend sends **pictures** of the page (at most 8 per second, and only while the pane is visible), and your clicks, scrolls and keys go back to it.
- Only `http://` and `https://` pages open. `file:`, `chrome:`, `javascript:` and the like are refused. **localhost is allowed**, because testing your dev server is the main use. hive's own web port (`HIVE_WEB_PORT`) is blocked. Downloads are turned off.
- The **open in your own browser** button (↗) opens the current page in your normal browser, with your own logins.

### What it needs

Any Chromium-family browser. hive looks for these, in order:

1. `HIVE_CHROMIUM`: a path to a Chrome or Chromium executable
2. Playwright's Chromium: run `npx playwright install chromium` once, or set `PLAYWRIGHT_BROWSERS_PATH`
3. An installed Microsoft Edge (every Windows PC has one), Google Chrome or Chromium. hive starts a fresh profile, never your own.

It runs headless (no window of its own), so it also works when hive runs on a server and you view it from another machine.

### What agents can do

| tool | what it does |
|---|---|
| `hive_browser_open {url}` | open a page |
| `hive_browser_click {selector}` or `{x, y}` | click an element (CSS, `text=Sign in`, `role=button[name="Save"]`) or a point on the 1280×800 page |
| `hive_browser_type {selector, text, submit?}` | fill a field, and press Enter if `submit` is set |
| `hive_browser_read {selector?}` | visible text of the page or of one element, marked as untrusted |
| `hive_browser_screenshot {full_page?}` | a PNG saved to `out/browser/` in the agent's folder (also attached as an image) |

There is no tool for running JavaScript in the page.

## Android

### Install adb and an emulator (Windows)

1. Install **Android Studio** from developer.android.com/studio. It includes `adb` (in "platform-tools") and the emulator.
2. In Android Studio, open **More Actions → Virtual Device Manager**, create a device (any Pixel) and download a system image.
3. hive looks for the SDK in `%LOCALAPPDATA%\Android\Sdk` (Android Studio's default), `ANDROID_HOME` or `ANDROID_SDK_ROOT`, and for `adb` on your PATH. To use another adb, set `HIVE_ADB` to its full path.
4. Open the Android pane. Your emulators are listed with a **Start** button. An emulator takes about a minute to boot, then shows up in the device list.

On macOS and Linux it works the same way. The default SDK folders are `~/Library/Android/sdk` and `~/Android/Sdk`. Debian and Ubuntu also offer `sudo apt install adb`.

### Connect a phone

**USB:** on the phone, open **Settings → About phone** and tap **Build number** seven times. Then turn on **Developer options → USB debugging**. Plug the phone in, unlock it and tap **Allow** on the "Allow USB debugging?" prompt. If the pane says "unauthorized", the prompt is still waiting on the phone.

**Wi-Fi (Android 11 and newer):** in **Developer options → Wireless debugging**, tap **Pair device with pairing code**. On the computer, run `adb pair <ip>:<pair-port>` and enter the code, then run `adb connect <ip>:<port>` (the port shown on the Wireless debugging screen). Then press refresh in the pane.

### Using the pane

- Click to tap. Drag to swipe (a drag upwards scrolls down).
- Typing sends text to the field that has focus. Enter, Backspace, Tab and the arrow keys are sent as keys, and Esc means Back.
- Use the **Back**, **Home**, **Recents** and **Rotate** buttons for those actions.
- **Install** installs an `.apk` from a path you type.
- **Launch** starts an app by its package name (for example `com.example.app`).
- The screen refreshes about three times a second while the pane is visible. Unchanged screens aren't re-sent.

### What agents can do

`hive_android_devices`, `hive_android_screenshot` (a PNG saved to `out/android/`), `hive_android_tap {x,y}`, `hive_android_swipe`, `hive_android_type {text}` (plain ASCII), `hive_android_key {key}` (back, home, recents, enter…), `hive_android_install {apk}` (only an APK inside the agent's own folder), `hive_android_launch {package}`, and `hive_android_ui_dump`. The UI dump lists the screen's buttons, texts and fields with their centre points, so an agent knows where to tap.

hive never passes raw shell commands to adb. Every argument is checked: numbers must be numbers, package and key names must match strict patterns, and text is quoted for the phone's shell.

## Safety

- **Every device tool asks first** under the `ask` and `allow-reads` policies. They're left out of hive's always-allowed tools, even reading and screenshots. The browser may hold logins you made there, and a phone screen shows your notifications and messages, so letting an agent read either is your decision. Agents with `allow-all` use the tools without asking.
- Text from web pages and apps reaches agents wrapped as **untrusted** data. A page that says "ignore your instructions" is treated as content, not as an order.
- The browser and adb run in the hive process (the UI backend or `hive serve`), never inside the agent. Agents queue requests through the hive database and the hub carries them out. If no hive window or `hive serve` is running, the tools say so.
- Using your own phone means agents can tap anything on it. Prefer an emulator, or a test phone without your accounts.
