// Entry of the browser / phone build (hive web): the WebSocket bridge first, then the same app as the desktop.
import "./web-bridge.js";
import "./main.js";

document.documentElement.dataset.web = "1";

// Status bar / browser chrome in the theme's colour (and the Android app's bars, through its small native hook).
const themeMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
const paintBars = () => {
  const c = getComputedStyle(document.documentElement).getPropertyValue("--bg-1").trim();
  if (!c) return;
  themeMeta?.setAttribute("content", c);
  try {
    (window as any).HiveAndroid?.setThemeColor(c, document.documentElement.dataset.tone === "light");
  } catch {}
};
new MutationObserver(paintBars).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-tone"] });
paintBars();

// Installable app (Add to Home screen) that opens instantly: the service worker keeps the app shell.
if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("sw.js").catch(() => {}));
}
