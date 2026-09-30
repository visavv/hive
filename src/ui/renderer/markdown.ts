/** Markdown for agent text. Raw HTML is disabled, so output is escaped and safe to inject. */
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
const defaultLink = md.renderer.rules.link_open ?? ((t, i, o, _e, s) => s.renderToken(t, i, o));
md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
  tokens[idx].attrSet("target", "_blank");
  tokens[idx].attrSet("rel", "noreferrer");
  return defaultLink(tokens, idx, opts, env, self);
};

// Agent output is untrusted: never load images from it (file:// and, on
// Windows, //host/share URLs would leak data or NTLM hashes). Show alt text + URL.
md.renderer.rules.image = (tokens, idx) => {
  const t = tokens[idx];
  const src = t.attrGet("src") ?? "";
  const alt = t.content || "image";
  return `<span class="img-blocked" title="${md.utils.escapeHtml(String(src))}">[${md.utils.escapeHtml(alt)}]</span>`;
};

// Small LRU for finished messages; streaming prefixes are not worth caching.
const cache = new Map<string, string>();
let cachedChars = 0;
export function renderMarkdown(src: string): string {
  const hit = cache.get(src);
  if (hit !== undefined) return hit;
  const html = md.render(src);
  if (src.length < 20_000) {
    cache.set(src, html);
    cachedChars += src.length;
    while (cache.size > 300 || cachedChars > 2_000_000) {
      const [k] = cache.keys();
      cache.delete(k);
      cachedChars -= k.length;
    }
  }
  return html;
}
