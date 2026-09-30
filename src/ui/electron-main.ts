/**
 * Electron main: a window plus a relay. It spawns the UI backend (system Node,
 * owns the Hub) and pipes NDJSON between it and the renderer over IPC.
 * No HTTP server, no remote content, no node in the renderer.
 */
import { app, BrowserWindow, ipcMain, globalShortcut, shell, dialog, Menu } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

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

let win: BrowserWindow | undefined;
let backend: ChildProcess | undefined;
let lastReady: string | undefined;

function startBackend() {
  const node = process.env.HIVE_NODE ?? (process.platform === "win32" ? "node.exe" : "node");
  const built = join(root, "dist", "ui", "backend.js");
  const src = join(root, "src", "ui", "backend.ts");
  const entry = existsSync(src) && !process.env.HIVE_UI_PROD ? [join(root, "node_modules", "tsx", "dist", "cli.mjs"), src] : [built];
  backend = spawn(node, [...entry, ...(dbPath ? ["--db", dbPath] : []), "--cwd", workDir], {
    cwd: workDir,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  backend.on("error", (e) => {
    dialog.showErrorBox("hive", `Could not start the hive backend with "${node}": ${e.message}\nSet HIVE_NODE to your node binary.`);
    app.quit();
  });
  backend.stderr?.on("data", (d) => process.stderr.write(`[backend] ${d}`));
  backend.on("exit", (code) => {
    if (!quitting) win?.webContents.send("hive:msg", JSON.stringify({ event: "error", text: `backend exited (${code})` }));
  });
  const rl = createInterface({ input: backend.stdout! });
  rl.on("line", (line) => {
    if (line.startsWith('{"event":"ready"')) lastReady = line;
    win?.webContents.send("hive:msg", line);
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
  void win.loadFile(join(__dirname, "index.html"));
  win.on("closed", () => (win = undefined));
}

let quitting = false;
app.on("before-quit", () => {
  quitting = true;
  backend?.stdin?.end();
  backend?.kill();
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  startBackend();
  ipcMain.on("hive:send", (_e, line: string) => backend?.stdin?.write(line + "\n"));
  // A reload re-requests the ready event instead of waiting for a new backend.
  ipcMain.handle("hive:hello", () => lastReady ?? null);
  createWindow();
  // Global hotkey: bring hive to front and focus the last active pane (Handy then types there).
  globalShortcut.register(process.env.HIVE_HOTKEY ?? "CommandOrControl+Alt+H", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send("hive:focus-last");
  });
});
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => app.quit());
