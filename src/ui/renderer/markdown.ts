/** Markdown for agent text. Raw HTML is disabled, so output is escaped and safe to inject. */
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
const defaultLink = md.renderer.rules.link_open ?? ((t, i, o, _e, s) => s.renderToken(t, i, o));
md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
  tokens[idx].attrSet("target", "_blank");
  tokens[idx].attrSet("rel", "noreferrer");
  return defaultLink(tokens, idx, opts, env, self);
};

const cache = new Map<string, string>();
export function renderMarkdown(src: string): string {
  const hit = cache.get(src);
  if (hit) return hit;
  const html = md.render(src);
  if (cache.size > 500) cache.clear();
  cache.set(src, html);
  return html;
}
