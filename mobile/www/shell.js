// The app's own pages: remember the hive address, open it full-screen, offer a way back when it can't load.
// The address (with its token) is kept in this app's local storage only.
(function () {
  var KEY = "hive.url";
  var get = function () {
    try {
      return localStorage.getItem(KEY) || "";
    } catch (e) {
      return "";
    }
  };
  var open = function (url) {
    // replace(): the setup page doesn't stay in history, so Back on hive leaves the app instead of looping here
    location.replace(url);
  };

  /** Accepts the full link, or the link without https://; returns an error message or the clean URL. */
  function check(raw) {
    var s = raw.trim();
    if (!s) return { err: "Paste the address first." };
    if (!/^https?:\/\//i.test(s)) s = "https://" + s;
    var u;
    try {
      u = new URL(s);
    } catch (e) {
      return { err: "That doesn't look like an address." };
    }
    if (u.protocol !== "https:") return { err: "Use the https:// address that `tailscale serve` gives you." };
    // must match allowNavigation in capacitor.config.json, or Android opens it in the browser instead
    if (!/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/i.test(u.hostname)) return { err: "The address should end in .ts.net (your machine on your tailnet), e.g. my-pc.tail1234.ts.net." };
    if (!/[#&]t=[A-Za-z0-9_-]{20,}/.test(u.hash)) return { err: "The address is missing its key (the #t=… part). Copy the whole line hive web printed." };
    return { url: u.toString() };
  }

  var setup = document.getElementById("setup");
  if (setup) {
    var saved = get();
    if (saved && location.search.indexOf("setup") < 0) return open(saved);
    setup.hidden = false;
    var input = document.getElementById("url");
    var err = document.getElementById("err");
    if (saved) input.value = saved;
    document.getElementById("form").addEventListener("submit", function (e) {
      e.preventDefault();
      var r = check(input.value);
      if (r.err) {
        err.textContent = r.err;
        return;
      }
      try {
        localStorage.setItem(KEY, r.url);
      } catch (x) {}
      open(r.url);
    });
    return;
  }

  // error.html
  var url = get();
  var where = document.getElementById("where");
  if (where && url) where.textContent = url.replace(/#.*$/, "");
  document.getElementById("retry").addEventListener("click", function () {
    open(url || "index.html?setup");
  });
  document.getElementById("change").addEventListener("click", function () {
    open("index.html?setup");
  });
})();
