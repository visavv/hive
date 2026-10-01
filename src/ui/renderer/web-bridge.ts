/**
 * window.hiveBridge for the browser / phone build (`hive web`): the same NDJSON
 * lines the Electron preload carries, over a WebSocket to the hive web server,
 * which relays them to the project's daemon.
 *
 * The key (token) comes from the link's #t=… on first open; it's kept in this
 * browser's localStorage and taken out of the address bar. The connection comes
 * back by itself (phone asleep, Wi-Fi ↔ mobile data): while it's away the UI
 * shows "reconnecting…" and re-syncs from the "ready" the daemon replays.
 */
const KEY = "hive.token";

function readToken(): string | null {
  const m = /(?:^#|&)t=([A-Za-z0-9_-]{20,})/.exec(location.hash);
  if (m) {
    try {
      localStorage.setItem(KEY, m[1]);
    } catch {}
    // keep the key out of the address bar, history and screenshots
    history.replaceState(null, "", location.pathname + location.search);
    return m[1];
  }
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

let token = readToken();
let ws: WebSocket | undefined;
let open = false;
let seenReady = false;
let attempt = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
/** Told the UI the connection is gone (once per outage). */
let downSent = false;
let stopped = false;
const listeners: ((line: string) => void)[] = [];
const early: string[] = [];
const readyWaiters: ((v: boolean) => void)[] = [];

function emit(line: string) {
  if (!listeners.length) early.push(line);
  else for (const l of listeners) l(line);
}

function setConn(state: "up" | "down" | "auth") {
  document.documentElement.dataset.conn = state;
}

function connect() {
  clearTimeout(timer);
  timer = undefined;
  if (stopped || ws) return;
  if (!token) return askForKey();
  const s = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?t=${encodeURIComponent(token)}`);
  ws = s;
  s.onopen = () => {
    open = true;
    attempt = 0;
    downSent = false;
    setConn("up");
  };
  s.onmessage = (e) => {
    if (typeof e.data !== "string") return;
    if (e.data.startsWith('{"event":"ready"')) {
      seenReady = true;
      emit(e.data);
      for (const w of readyWaiters.splice(0)) w(true);
      return;
    }
    emit(e.data);
  };
  s.onclose = () => {
    const wasOpen = open;
    open = false;
    ws = undefined;
    setConn("down");
    if (!downSent && (wasOpen || seenReady)) {
      downSent = true;
      // same event the desktop app gets when its backend goes away: pending requests fail, the UI says so
      emit(JSON.stringify({ event: "backend_down", text: "connection to hive lost; reconnecting…" }));
    }
    if (!wasOpen) void checkKey();
    // 0.5s, 1s, 2s … 30s, with jitter so several tabs don't knock in step
    const delay = Math.min(30_000, 500 * 2 ** Math.min(attempt++, 6)) * (0.8 + Math.random() * 0.4);
    timer = setTimeout(connect, delay);
  };
}

/** The socket never opened: wrong key, or just offline? Only a definite "wrong key" stops the retries. */
async function checkKey() {
  try {
    const r = await fetch("auth", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    if (r.status === 401) {
      stopped = true;
      clearTimeout(timer);
      try {
        localStorage.removeItem(KEY);
      } catch {}
      askForKey("That key doesn't open this hive (it may have been renewed with --new-token).");
    }
  } catch {}
}

/** Come back right away when the phone wakes up or the network returns, instead of waiting out the backoff. */
function nudge() {
  if (!ws && !stopped && document.visibilityState === "visible") {
    attempt = 0;
    connect();
  }
}
document.addEventListener("visibilitychange", nudge);
window.addEventListener("online", nudge);
window.addEventListener("pageshow", nudge);

/** No key yet (opened without #t=…) or a wrong one: a small screen to paste the link hive web printed. */
function askForKey(problem?: string) {
  setConn("auth");
  if (document.getElementById("hive-key")) return;
  const box = document.createElement("form");
  box.id = "hive-key";
  box.className = "web-key";
  box.innerHTML = `
    <div class="web-key-card">
      <h1>hive</h1>
      <p>Paste the link <code>hive web</code> printed on your computer (or just the key after <code>#t=</code>).</p>
      <input name="k" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://…/#t=…" aria-label="link or key" />
      <p class="err" role="alert"></p>
      <button class="primary" type="submit">Connect</button>
    </div>`;
  (box.querySelector(".err") as HTMLElement).textContent = problem ?? "";
  box.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = (box.querySelector("input") as HTMLInputElement).value.trim();
    const k = /[#&]t=([A-Za-z0-9_-]{20,})/.exec(v)?.[1] ?? (/^[A-Za-z0-9_-]{20,}$/.test(v) ? v : null);
    if (!k) {
      (box.querySelector(".err") as HTMLElement).textContent = "That doesn't look like the link or key.";
      return;
    }
    token = k;
    try {
      localStorage.setItem(KEY, k);
    } catch {}
    box.remove();
    stopped = false;
    attempt = 0;
    connect();
  });
  document.body.appendChild(box);
  (box.querySelector("input") as HTMLInputElement).focus();
}

window.hiveBridge = {
  send(line: string) {
    if (open && ws) return ws.send(line);
    // answer now instead of leaving the request hanging until the connection is back
    try {
      const { id } = JSON.parse(line);
      if (typeof id === "number") setTimeout(() => emit(JSON.stringify({ id, error: "not connected to hive (reconnecting…)" })), 0);
    } catch {}
  },
  onMessage(fn: (line: string) => void) {
    listeners.push(fn);
    for (const l of early.splice(0)) fn(l);
  },
  onFocusLast() {},
  hello: () => (seenReady ? Promise.resolve(true) : new Promise<boolean>((r) => readyWaiters.push(r))),
  attention() {
    try {
      navigator.vibrate?.(60);
    } catch {}
  },
  // no pickFile: a browser can't hand the server a path on its disk (the UI hides "Browse…")
};

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", connect, { once: true });
else connect();

export {}; // a module: its names stay out of the global scope
