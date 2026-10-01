/**
 * Electron main: a window plus a relay. It spawns the UI backend (system Node,
 * owns the Hub) and pipes NDJSON between it and the renderer over IPC.
 * No HTTP server, no remote content, no node in the renderer.
 */
import { app, BrowserWindow, ipcMain, globalShortcut, shell, dialog, Menu, session } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Bundled to dist-ui/main.cjs; the repo root is one level up.
const root = resolve(__dirname, "..");
const args = process.argv.slice(app.isPackaged ? 1 : 2);
const argVal = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const workDir = resolve(argVal("--cwd") ?? process.env.HIVE_CWD ?? process.cwd());
const dbArg = argVal("--db") ?? process.env.HIVE_DB_PATH;
const dbPath = dbArg ? resolve(workDir, dbArg) : undefined; // backend picks the per-repo default

// Linux: WM_CLASS / desktop-entry matching; on Wayland, global shortcuts go through the desktop portal.
app.setName("hive");
const wayland = process.platform === "linux" && (process.env.XDG_SESSION_TYPE === "wayland" || !!process.env.WAYLAND_DISPLAY);
if (wayland) app.commandLine.appendSwitch("enable-features", "GlobalShortcutsPortal");

let win: BrowserWindow | undefined;
let backend: ChildProcess | undefined;
let backendReady = false;
let quitting = false;
let restarts: number[] = [];

const toRenderer = (msg: object | string) => win?.webContents.send("hive:msg", typeof msg === "string" ? msg : JSON.stringify(msg));

function startBackend() {
  const node = process.env.HIVE_NODE ?? (process.platform === "win32" ? "node.exe" : "node");
  const built = join(root, "dist", "ui", "backend.js");
  const src = join(root, "src", "ui", "backend.ts");
  const entry = existsSync(src) && !process.env.HIVE_UI_PROD ? [join(root, "node_modules", "tsx", "dist", "cli.mjs"), src] : [built];
  backendReady = false;
  const proc = spawn(node, [...entry, ...(dbPath ? ["--db", dbPath] : []), "--cwd", workDir, "--owner-pid", String(process.pid)], {
    cwd: workDir,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  backend = proc;
  proc.on("error", (e) => {
    dialog.showErrorBox("hive", `Could not start the hive backend with "${node}": ${e.message}\nSet HIVE_NODE to your node binary.`);
    app.quit();
  });
  proc.stderr?.on("data", (d) => process.stderr.write(`[backend] ${d}`));
  let fatal = "";
  proc.on("exit", (code) => {
    if (backend === proc) backend = undefined;
    if (quitting) return;
    if (fatal) {
      dialog.showErrorBox("hive", fatal);
      app.quit();
      return;
    }
    // Pending renderer requests will never be answered: let it reject them.
    toRenderer({ event: "backend_down", text: `backend exited (${code}); restarting…` });
    const now = Date.now();
    restarts = restarts.filter((t) => now - t < 60_000);
    if (restarts.length >= 5) {
      dialog.showErrorBox("hive", "The hive backend keeps crashing (5 times in a minute). See the terminal output for details.");
      return;
    }
    restarts.push(now);
    setTimeout(startBackend, 500 * restarts.length);
  });
  const rl = createInterface({ input: proc.stdout! });
  rl.on("line", (line) => {
    if (line.startsWith('{"event":"fatal"')) {
      try {
        fatal = JSON.parse(line).text;
      } catch {}
      return;
    }
    if (line.startsWith('{"event":"ready"')) backendReady = true;
    toRenderer(line);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    backgroundColor: "#111318",
    title: `hive — ${workDir}`,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  // A crashed renderer comes back by itself; it re-syncs from the backend.
  win.webContents.on("render-process-gone", () => setTimeout(() => win?.webContents.reload(), 500));
  // Ctrl+Shift+R reloads the renderer (there is no menu).
  win.webContents.on("before-input-event", (e, input) => {
    if (input.type === "keyDown" && input.control && input.shift && input.key.toLowerCase() === "r") {
      e.preventDefault();
      win?.webContents.reload();
    }
  });
  void win.loadFile(join(__dirname, "index.html"));
  win.on("focus", () => win?.flashFrame(false));
  win.on("closed", () => (win = undefined));
}

app.on("before-quit", (e) => {
  if (quitting || !backend) return;
  // Let the backend close its agents (on Windows kill() would skip that and
  // leave adapter processes behind), then quit for real.
  e.preventDefault();
  quitting = true;
  const proc = backend;
  const done = () => app.quit();
  proc.once("exit", done);
  proc.stdin?.end();
  setTimeout(() => {
    proc.kill();
    done();
  }, 6000).unref();
});

app.whenReady().then(() => {
  if (process.platform === "win32") app.setAppUserModelId("hive");
  Menu.setApplicationMenu(null);
  // Agent markdown can reference file: URLs (on Windows //host/x is an SMB
  // share and leaks NTLM hashes). Only the app's own files may load.
  const appDir = resolve(__dirname) + sep;
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    if (details.url.startsWith("file:")) {
      let p = "";
      try {
        p = resolve(fileURLToPath(details.url));
      } catch {}
      return cb({ cancel: !p.startsWith(appDir) });
    }
    if (details.url.startsWith("devtools:") || details.url.startsWith("data:")) return cb({});
    cb({ cancel: true }); // no network from the renderer
  });
  startBackend();
  ipcMain.on("hive:send", (_e, line: string) => {
    if (backend?.stdin?.writable) backend.stdin.write(line + "\n");
    else {
      // Answer the request now instead of leaving it hanging.
      try {
        const { id } = JSON.parse(line);
        if (typeof id === "number") toRenderer({ id, error: "hive backend is restarting" });
      } catch {}
    }
  });
  // Native file picker for skill parameters (transcripts etc.). Returns a path only.
  ipcMain.handle("hive:pick-file", async () => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, {
      defaultPath: workDir,
      properties: ["openFile"],
      filters: [
        { name: "Transcripts & text", extensions: ["txt", "srt", "vtt", "md", "json", "csv"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  ipcMain.on("hive:attention", () => {
    if (win && !win.isFocused()) win.flashFrame(true);
  });
  // A (re)loaded renderer asks whether the backend is up; if so it fetches state.
  ipcMain.handle("hive:hello", () => backendReady);
  createWindow();
  // Global hotkey: bring hive to front and focus the last active pane (Handy then types there).
  const hotkey = process.env.HIVE_HOTKEY ?? "CommandOrControl+Alt+H";
  const ok = globalShortcut.register(hotkey, () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send("hive:focus-last");
  });
  if (!ok)
    win?.webContents.once("did-finish-load", () =>
      toRenderer({
        event: "error",
        text: wayland
          ? `global hotkey ${hotkey} isn't available on this Wayland desktop; add a keyboard shortcut in your desktop settings that runs "hive ui" instead`
          : `global hotkey ${hotkey} is taken by another app; set HIVE_HOTKEY to change it`,
      }),
    );
});
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => app.quit());
